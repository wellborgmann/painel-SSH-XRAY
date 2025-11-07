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
// 💡 LÓGICA STATELESS (VERCEL COMPATÍVEL)
// Uma nova conexão é criada e fechada para cada operação.
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
// Exportações de Gerenciamento de Usuários (Ajustadas para Stateless)
// =======================================================


// Função para criar um usuário SSH no servidor
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

// Função para reiniciar o serviço V2Ray
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
    // Nota: O método de validação JSON do original pode não ser o ideal, 
    // mas foi mantido para fins de conversão.
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

// Função principal para criar um novo usuário VPN (SSH e V2Ray)
export async function NewUserVPN(data) {
  console.log("Iniciando criação de usuário VPN...");

  try {
    // Criar novo usuário V2Ray e atualizar o JSON
    const newUserV2 = newV2ray(data.user);
    const arquivo = await lerJson();

  // Encontra o inbound correto
const inboundVless = arquivo.inbounds.find(
  (inbound) => inbound.protocol === "vless" && inbound.settings?.clients
);

if (!inboundVless) {
  throw new Error("Nenhum inbound VLESS com lista de clients encontrado!");
}

// Adiciona o novo usuário ao array
inboundVless.settings.clients.push(newUserV2);

    
    if (!validarJsonV2Ray(arquivo)) {
      throw new Error("Erro de formatação no JSON de configuração do V2Ray!");
    }

    await SalvarJson(arquivo);

    // Executar as operações SSH e reiniciar V2Ray em paralelo usando Promise.all
    await Promise.all([
      criarUsuario(data.user, data.password, data.days, data.limit),
      daemonReload(),
      restartV2Ray(),
    ]);

    // Verificar o status do V2Ray após reiniciar
    const status = await checkV2RayStatus();
    console.log("Status do V2Ray após reiniciar:", status);

    // Retornar os dados combinados do usuário criado
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


const comando = `echo "FZpwoU:1111" | sudo chpasswd`;
// Esta linha deve ser removida ou alterada, pois será executada toda vez que o módulo for carregado
// (o que acontece em cada requisição na Vercel). Vou comentar ela por segurança.
// executarComandoSSH(comando);


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
    // Nota: O seu comando shell está formatado para retornar um JSON
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
    return executarComandoSSH(comandoRemoverUsuario);
  }

  let users = await lerJson();
  users.inbounds.forEach(inbound => {
    if (inbound.settings && inbound.settings.clients) {
      inbound.settings.clients = inbound.settings.clients.filter(
        client => client.email !== username
      );
    }
  });
  await SalvarJson(users);

  return executarComandoSSH(comandoRemoverUsuario);
}



export async function alterarSenha(data) {
  try {
    // O parâmetro 'true' indica para o 'removerUsuarioSSH' não mexer no JSON do V2Ray
    await removerUsuarioSSH(data.user, true); 
    await criarUsuario(data.user, data.pass, data.days, 1);
    return true; 
  } catch (error) {
    console.log(error);
    throw error;
  }
}


export function infoLogin(loginName) {
  return new Promise((resolve, reject) => {
    const comando = `chage -l ${loginName} | grep -E 'Account expires' | cut -d ' ' -f3-`;
    const conn = new Client(); // Novo cliente para esta execução
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
              conn.end(); // CRÍTICO: Encerra a conexão após o comando
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
                // Assumindo que se não houver dados, o usuário não existe ou comando falhou
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

// Nota: A função 'isExpired' estava definida, mas não era exportada ou usada no exemplo de uso
export function isExpired(obj) {
  const now = new Date();
  if (!obj || !obj.data) return false;
  const data = obj.data instanceof Date ? obj.data : new Date(obj.data);
  if (isNaN(data.getTime())) throw new Error('Data inválida');
  return data < now;
}

/**
 * Lista todos os usuários e senhas do diretório remoto /etc/SSHPlus/senha
 * Retorna um array de objetos: [{ username, password }, ...]
 */
export async function listarUsuarios() {
  try {
    // Comando para ler todos os arquivos e conteúdos do diretório
    const command = `
      for file in /etc/SSHPlus/senha/*; do
        [ -f "$file" ] && echo "$(basename "$file") $(cat "$file")"
      done
    `;
    
    const resultado = await executarComandoSSH(command);

    // Cada linha terá: username password
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

// Bloco IIFE (Immediately Invoked Function Expression) para manter a lógica de teste original
// Comentado para evitar a execução imediata ao importar o módulo
/*
(async () => {
  const usuarios = await infoLogin("apollo404");
  console.log(usuarios);
})();
*/

// O export default foi removido, mas você pode exportar todas as funções separadamente (o que já foi feito)
// ou exportá-las como um objeto, se preferir.
// O código acima exporta todas as funções que estavam no `module.exports`.