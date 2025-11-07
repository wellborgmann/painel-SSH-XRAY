import dotenv from "dotenv";
import { Client } from "ssh2";
import { v4 as uuidv4 } from "uuid";

// Configure o dotenv imediatamente
dotenv.config();

// Seus imports de gerenciamento de JSON
import { lerJson, SalvarJson } from "./jsonManager.js";


const connSettings = {
  host: process.env.SSH_IP,
  port: process.env.SSH_PORT,
  username: process.env.SSH_USER,
  password: process.env.SSH_PASSWORD,
  // Mantemos o timeout estendido para maior estabilidade em redes lentas
  readyTimeout: 45000, 
  handshakeTimeout: 45000 
};

// =======================================================
// FUNÇÃO GENÉRICA SSH
// =======================================================

/**
 * Função genérica para executar comandos SSH no servidor.
 * Uma nova conexão é estabelecida para cada chamada.
 * @param {string} comando O comando shell a ser executado.
 * @returns {Promise<string>} O output do comando.
 */
export function executarComandoSSH(comando) {
  return new Promise((resolve, reject) => {
    const conn = new Client(); // Novo cliente para esta execução
    
    conn.on("error", (err) => {
        conn.end();
        reject(err);
    });

    conn
      .on("ready", () => {
        conn.exec(comando, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          
          let output = "";
          stream
            .on("close", (code, signal) => {
              conn.end(); // CRÍTICO: Encerra a conexão após o comando
              resolve(output);
            })
            .on("data", (data) => (output += data.toString()))
            .stderr.on("data", (data) => (output += data.toString()));
        });
      })
      .connect(connSettings);
  });
}

// =======================================================
// OPERAÇÕES SSH ATÔMICAS (CRIAÇÃO E MODIFICAÇÃO)
// =======================================================

// Função para criar um usuário SSH (Apenas a criação é feita via useradd)
export function criarUsuario(login, senha, dias, limite) {
  const comando = `
      #!/bin/bash
      username="${login}"
      password="${senha}"
      dias="${dias}"
      sshlimiter="${limite}"
      final=$(date "+%Y-%m-%d" -d "+$dias days")
      
      # Criptografa a senha usando openssl
      pass=$(openssl passwd -1 "$password")
      
      useradd -e "$final" -M -s /bin/false -p "$pass" "$username"
      echo "$password" > /etc/SSHPlus/senha/"$username"
      echo "$username $sshlimiter" >> /root/usuarios.db
    `;

  return executarComandoSSH(comando);
}

/**
 * Altera a senha e a data de expiração de um usuário SSH existente.
 * *** NUNCA REMOVE O USUÁRIO. APENAS MODIFICA. ***
 * @param {string} login O nome de usuário.
 * @param {string} senha A nova senha.
 * @param {number} dias O novo número de dias de expiração.
 * @returns {Promise<string>} O output do comando.
 */
export function alterarUsuarioSSH(login, senha, dias) {
  const comando = `
      #!/bin/bash
      username="${login}"
      password="${senha}"
      dias="${dias}"
      
      # 1. Altera a data de expiração (chage -E)
      finaldate=$(date "+%Y-%m-%d" -d "+$dias days")
      chage -E "$finaldate" "$username"
      
      # 2. Altera a senha (chpasswd - Operação atômica)
      # Requer permissão sudo para o usuário SSH na VPS
      echo "${username}:${password}" | sudo chpasswd
      
      # 3. Atualiza o arquivo de senha SSHPlus
      echo "$password" > /etc/SSHPlus/senha/"$username"
      
      exit 0
    `;

  return executarComandoSSH(comando);
}

// =======================================================
// FUNÇÕES DE SERVIÇO (V2RAY)
// =======================================================

function restartV2Ray() {
  return executarComandoSSH("systemctl restart xray");
}
function daemonReload() {
  return executarComandoSSH("systemctl daemon-reload");
}
function checkV2RayStatus() {
  return executarComandoSSH("systemctl is-active xray");
}

function validarJsonV2Ray(json) {
  try {
    JSON.parse(JSON.stringify(json)); 
    return true;
  } catch (error) {
    return false;
  }
}

// Gera um novo objeto de usuário para V2Ray
function newV2ray(email) {
  return {
    id: uuidv4(),
    level: 0,
    email: email,
  };
}

// =======================================================
// EXPORTAÇÕES PRINCIPAIS
// =======================================================

/**
 * Função principal para criar um novo usuário VPN (SSH e V2Ray).
 * Inclui verificação de duplicidade no JSON.
 */
export async function NewUserVPN(data) {
  console.log("Iniciando criação de usuário VPN...");

  try {
    // 1. Verificar e Adicionar novo usuário V2Ray ao JSON
    const newUserV2 = newV2ray(data.user);
    const arquivo = await lerJson();

    // Encontra o inbound correto (VLESS)
    const inboundVless = arquivo.inbounds.find(
      (inbound) => inbound.protocol === "vless" && inbound.settings?.clients
    );

    if (!inboundVless) {
      throw new Error("Nenhum inbound VLESS com lista de clients encontrado!");
    }
    
    // VERIFICAÇÃO DE DUPLICIDADE (CHAVE DE SEGURANÇA)
    const userExistsInV2Ray = inboundVless.settings.clients.some(
      (client) => client.email === data.user
    );

    if (userExistsInV2Ray) {
      throw new Error(`Usuário '${data.user}' já existe na configuração do V2Ray. A operação foi abortada.`);
    }

    // Adiciona o novo usuário ao array APENAS SE NÃO EXISTIR
    inboundVless.settings.clients.push(newUserV2);

    
    if (!validarJsonV2Ray(arquivo)) {
      throw new Error("Erro de formatação no JSON de configuração do V2Ray!");
    }

    // Grava o JSON de forma atômica
    await SalvarJson(arquivo);

    // 2. Executar as operações SSH e reiniciar V2Ray em paralelo
    await Promise.all([
      criarUsuario(data.user, data.password, data.days, data.limit),
      daemonReload(),
      restartV2Ray(),
    ]);

    const status = await checkV2RayStatus();
    console.log("Status do V2Ray após reiniciar:", status);

    return {
      username: data.user,
      password: data.password,
      days: data.days,
      limit: data.limit,
      uuid: newUserV2.id,
    };
  } catch (error) {
    console.error("Erro na criação de usuário VPN:", error);
    throw error;
  }
}

/**
 * Altera a senha e a data de expiração de um usuário de forma segura,
 * sem removê-lo previamente.
 * @param {object} data Objeto contendo user, pass, e days.
 * @returns {Promise<boolean>} Retorna true em caso de sucesso.
 */
export async function alterarSenha(data) {
  try {
    // Usa a modificação atômica (chage/chpasswd)
    await alterarUsuarioSSH(data.user, data.pass, data.days);
    
    console.log(`Senha e data alteradas para o usuário: ${data.user}`);
    return true; 
  } catch (error) {
    console.error("Erro na alteração de senha (modificação):", error);
    throw error;
  }
}


export function getUsers() {
  const command = "awk -F: '$3 >= 1000 && $3 < 65534 { print $1 }' /etc/passwd";
  return executarComandoSSH(command);
}

export function alterarData(login, dias) {
  let comando =
    `#!/bin/bash
  clear
  usuario=` +
    login +
    `
  dias=` +
    dias +
    `
  finaldate=$(date "+%Y-%m-%d" -d "+$dias days")
  gui=$(date "+%d/%m/%Y" -d "+$dias days")
  chage -E $finaldate $usuario`;
  return executarComandoSSH(comando);
}

export async function online() {
  try {
    const command = `
    #!/bin/bash
    ssh_users=$(ps aux | grep 'sshd:.*\\[priv\\]' | awk -F 'sshd: ' '{print $2}' | awk '{print $1}' | sort)
    LOG_FILE="/var/log/xray/access.log"
    CURRENT_TIME=$(date +%s)
    last_log_entries=$(tail -n 100 "$LOG_FILE" | grep -i 'email:')
    TIME_LIMIT=60

    active_v2ray_users=$(echo "$last_log_entries" | while read -r line; do
        log_time=$(echo "$line" | awk '{print $1" "$2}')
        log_timestamp=$(date -d "$log_time" +%s)
        time_diff=$((CURRENT_TIME - log_timestamp))

        if [ "$time_diff" -le "$TIME_LIMIT" ]; then
            echo "$line" | grep -oP '(?<=email: )\\S+' | sed 's/@.*//'
        fi
    done | sort | uniq)

    ssh_json=$(echo "$ssh_users" | jq -R -s -c 'split("\\n")[:-1]')
    v2ray_json=$(echo "$active_v2ray_users" | jq -R -s -c 'split("\\n")[:-1]')

    json_output=$(jq -n --argjson ssh "$ssh_json" --argjson v2ray "$v2ray_json" '{ssh: $ssh, v2ray: $v2ray}')
    echo "$json_output"
  `;
    const result = await executarComandoSSH(command);
    
    const { ssh: sshUsersArray, v2ray: v2rayUsersArray } = JSON.parse(result);
    
    const sshCounts = {};
    sshUsersArray.forEach((user) => {
      sshCounts[user] = (sshCounts[user] || 0) + 1;
    });

    const v2rayCounts = {};
    v2rayUsersArray.forEach((user) => {
      v2rayCounts[user] = (v2rayCounts[user] || 0) + 1;
    });

    const online = {
      ssh: Object.entries(sshCounts).map(([user, count]) => ({ user, count })),
      v2ray: Object.entries(v2rayCounts).map(([user, count]) => ({
        user,
        count,
      })),
    };

    return online;
  } catch (error) {
    console.log(error);
  }
}

/**
 * Remove um usuário completamente ou apenas a parte SSH (modo editar).
 */
export async function removerUsuarioSSH(username, editar) {
  const comandoRemoverUsuario = `
      USR_EX="${username}";
      if id "$USR_EX" &>/dev/null; then
          kill -9 $(ps -fu "$USR_EX" | awk '{print $2}' | grep -v PID);
          userdel "$USR_EX";
          grep -v "^$USR_EX[[:space:]]" /root/usuarios.db > /tmp/ph && mv /tmp/ph /root/usuarios.db;
          rm /etc/SSHPlus/senha/"$USR_EX" 1>/dev/null 2>/dev/null;
          rm /etc/usuarios/"$USR_EX" 1>/dev/null 2>/dev/null;
          exit 0;
      fi
      exit 1;
  `;

  if (editar) {
    // Modo Edição: Remove apenas o SSH. Não mexe no V2Ray.
    return executarComandoSSH(comandoRemoverUsuario);
  }

  // MODO REMOÇÃO COMPLETA: 1. Remover SSH, 2. Alterar JSON (Ordem mais segura)
  
  await executarComandoSSH(comandoRemoverUsuario); 

  let users = await lerJson();
  users.inbounds.forEach(inbound => {
    if (inbound.settings && inbound.settings.clients) {
      inbound.settings.clients = inbound.settings.clients.filter(
        client => client.email !== username
      );
    }
  });
  await SalvarJson(users); 

  return true; 
}


export function infoLogin(loginName) {
  return new Promise((resolve, reject) => {
    const comando = `chage -l ${loginName} | grep -E 'Account expires' | cut -d ' ' -f3-`;
    const conn = new Client(); 
    let dataReceived = "";
    
    conn.on("error", (err) => {
      conn.end();
      reject(err);
    });

    conn
      .on("ready", () => {
        conn.exec(comando, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          stream
            .on("close", () => {
              conn.end();
              if (dataReceived) {
                const trimmedData = dataReceived.trim();
                if (trimmedData === "never") {
                  resolve({ loginName, exists: true, data: null });
                } else {
                  const expirationDate = new Date(trimmedData);
                  if (isNaN(expirationDate)) {
                    reject(new Error("Data de expiração inválida recebida"));
                  } else {
                    resolve({ loginName, exists: true, data: expirationDate });
                  }
                }
              } else {
                resolve({ loginName, exists: false }); 
              }
            })
            .on("data", (data) => {
              dataReceived += data.toString();
            })
            .stderr.on("data", (data) => {
              console.error("Erro de execução do comando:", data.toString());
            });
        });
      })
      .connect(connSettings);
  });
}

export function isExpired(obj) {
  const now = new Date();
  if (!obj || !obj.data) return false;
  const data = obj.data instanceof Date ? obj.data : new Date(obj.data);
  if (isNaN(data.getTime())) throw new Error('Data inválida');
  return data < now;
}

export async function listarUsuarios() {
  try {
    const command = `
      for file in /etc/SSHPlus/senha/*; do
        [ -f "$file" ] && echo "$(basename "$file") $(cat "$file")"
      done
    `;
    
    const resultado = await executarComandoSSH(command);

    const usuarios = resultado
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => {
        const [username, ...senhaArr] = line.split(" ");
        return { username, password: senhaArr.join(" ") };
      });

    return usuarios;
  } catch (err) {
    console.error("Erro ao listar usuários e senhas remotas:", err);
    return [];
  }
}