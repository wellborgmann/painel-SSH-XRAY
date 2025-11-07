import dotenv from "dotenv";
import { Client } from "ssh2";
import { v4 as uuidv4 } from "uuid";
import { lerJson, SalvarJson } from "./jsonManager.js";

dotenv.config();

const connSettings = {
  host: process.env.SSH_IP,
  port: Number(process.env.SSH_PORT) || 22,
  username: process.env.SSH_USER,
  password: process.env.SSH_PASSWORD,
  readyTimeout: 45000,
  handshakeTimeout: 45000,
};

// =======================================================
// FUNÇÃO CENTRAL DE CONEXÃO
// =======================================================

function criarConexaoSSH() {
  return new Promise((resolve, reject) => {
    const conn = new Client();

    conn
      .on("ready", () => resolve(conn))
      .on("error", (err) => {
        conn.end();
        reject(new Error(`Erro na conexão SSH: ${err.message}`));
      })
      .connect(connSettings);
  });
}

// =======================================================
// EXECUÇÃO DE COMANDOS
// =======================================================

export async function executarComandoSSH(comando) {
  const conn = await criarConexaoSSH();
  return new Promise((resolve, reject) => {
    let output = "";
    conn.exec(comando, (err, stream) => {
      if (err) {
        conn.end();
        return reject(err);
      }
      stream
        .on("data", (data) => (output += data.toString()))
        .stderr.on("data", (data) => (output += data.toString()))
        .on("close", () => {
          conn.end();
          resolve(output.trim());
        });
    });
  });
}

// =======================================================
// OPERAÇÕES SSH: CRIAÇÃO E MODIFICAÇÃO
// =======================================================

export function criarUsuario(login, senha, dias, limite) {
  const comando = `
    username="${login}"
    password="${senha}"
    dias="${dias}"
    sshlimiter="${limite}"
    final=$(date "+%Y-%m-%d" -d "+$dias days")
    pass=$(openssl passwd -1 "$password")

    useradd -e "$final" -M -s /bin/false -p "$pass" "$username"
    echo "$password" > /etc/SSHPlus/senha/"$username"
    echo "$username $sshlimiter" >> /root/usuarios.db
  `;
  return executarComandoSSH(comando);
}

export function alterarUsuarioSSH(login, senha) {
  const comando = `
    username="${login}"
    password="${senha}"
    echo "${login}:${senha}" | sudo chpasswd
    echo "$password" > /etc/SSHPlus/senha/"$username"
  `;
  return executarComandoSSH(comando);
}

// =======================================================
// SERVIÇOS V2RAY
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
  } catch {
    return false;
  }
}

function newV2ray(email) {
  return { id: uuidv4(), level: 0, email };
}

// =======================================================
// FUNÇÕES PRINCIPAIS
// =======================================================

export async function NewUserVPN(data) {
  console.log("🟢 Iniciando criação de usuário VPN...");

  try {
    const newUserV2 = newV2ray(data.user);
    const arquivo = await lerJson();

    const inboundVless = arquivo.inbounds.find(
      (i) => i.protocol === "vless" && i.settings?.clients
    );
    if (!inboundVless)
      throw new Error("Nenhum inbound VLESS com lista de clients encontrado!");

    const existe = inboundVless.settings.clients.some(
      (c) => c.email === data.user
    );
    if (existe)
      throw new Error(`Usuário '${data.user}' já existe no V2Ray!`);

    inboundVless.settings.clients.push(newUserV2);

    if (!validarJsonV2Ray(arquivo))
      throw new Error("Erro de formatação no JSON de configuração!");

    await SalvarJson(arquivo);

    await Promise.all([
      criarUsuario(data.user, data.password, data.days, data.limit),
      daemonReload(),
      restartV2Ray(),
    ]);

    const status = await checkV2RayStatus();
    console.log("✅ V2Ray reiniciado. Status:", status);

    return {
      username: data.user,
      password: data.password,
      days: data.days,
      limit: data.limit,
      uuid: newUserV2.id,
    };
  } catch (err) {
    console.error("❌ Erro na criação de usuário VPN:", err);
    throw err;
  }
}

export async function alterarSenha(data) {
  try {
    await alterarUsuarioSSH(data.user, data.pass);
    console.log(`🔄 Senha alterada para o usuário: ${data.user}`);
    return true;
  } catch (err) {
    console.error("Erro ao alterar senha:", err);
    throw err;
  }
}

// =======================================================
// OUTRAS FUNÇÕES AUXILIARES
// =======================================================

export function getUsers() {
  const command =
    "awk -F: '$3 >= 1000 && $3 < 65534 { print $1 }' /etc/passwd";
  return executarComandoSSH(command);
}

export function alterarData(login, dias) {
  const comando = `
    usuario="${login}"
    dias="${dias}"
    finaldate=$(date "+%Y-%m-%d" -d "+$dias days")
    chage -E $finaldate $usuario
  `;
  return executarComandoSSH(comando);
}

export async function online() {
  try {
    const command = `
      ssh_users=$(ps aux | grep 'sshd:.*\\[priv\\]' | awk -F 'sshd: ' '{print $2}' | awk '{print $1}' | sort)
      LOG_FILE="/var/log/xray/access.log"
      CURRENT_TIME=$(date +%s)
      last_log_entries=$(tail -n 100 "$LOG_FILE" | grep -i 'email:')
      TIME_LIMIT=60

      active_v2ray_users=$(echo "$last_log_entries" | while read -r line; do
          log_time=$(echo "$line" | awk '{print $1" "$2}')
          log_timestamp=$(date -d "$log_time" +%s)
          time_diff=$((CURRENT_TIME - log_timestamp))
          [ "$time_diff" -le "$TIME_LIMIT" ] && echo "$line" | grep -oP '(?<=email: )\\S+' | sed 's/@.*//'
      done | sort | uniq)

      ssh_json=$(echo "$ssh_users" | jq -R -s -c 'split("\\n")[:-1]')
      v2ray_json=$(echo "$active_v2ray_users" | jq -R -s -c 'split("\\n")[:-1]')
      jq -n --argjson ssh "$ssh_json" --argjson v2ray "$v2ray_json" '{ssh: $ssh, v2ray: $v2ray}'
    `;

    const result = await executarComandoSSH(command);
    const { ssh, v2ray } = JSON.parse(result);

    const contar = (arr) =>
      Object.entries(
        arr.reduce((acc, u) => ((acc[u] = (acc[u] || 0) + 1), acc), {})
      ).map(([user, count]) => ({ user, count }));

    return { ssh: contar(ssh), v2ray: contar(v2ray) };
  } catch (err) {
    console.error("Erro ao listar usuários online:", err);
    return { ssh: [], v2ray: [] };
  }
}

export async function removerUsuarioSSH(username, editar) {
  const comando = `
    USR_EX="${username}";
    if id "$USR_EX" &>/dev/null; then
        kill -9 $(ps -fu "$USR_EX" | awk '{print $2}' | grep -v PID);
        userdel "$USR_EX";
        grep -v "^$USR_EX[[:space:]]" /root/usuarios.db > /tmp/ph && mv /tmp/ph /root/usuarios.db;
        rm -f /etc/SSHPlus/senha/"$USR_EX" /etc/usuarios/"$USR_EX";
        exit 0;
    fi
    exit 1;
  `;

  if (editar) return executarComandoSSH(comando);

  await executarComandoSSH(comando);

  const json = await lerJson();
  json.inbounds.forEach((inb) => {
    if (inb.settings?.clients)
      inb.settings.clients = inb.settings.clients.filter(
        (c) => c.email !== username
      );
  });
  await SalvarJson(json);

  return true;
}

export function infoLogin(username) {
  return new Promise(async (resolve, reject) => {
    const conn = await criarConexaoSSH();
    const comando = `chage -l ${username} | grep -E 'Account expires' | cut -d ' ' -f3-`;
    let data = "";

    conn.exec(comando, (err, stream) => {
      if (err) {
        conn.end();
        return reject(err);
      }
      stream
        .on("data", (chunk) => (data += chunk.toString()))
        .on("close", () => {
          conn.end();
          const trimmed = data.trim();
          if (!trimmed) return resolve({ username, exists: false });
          if (trimmed === "never")
            return resolve({ username, exists: true, data: null });

          const date = new Date(trimmed);
          if (isNaN(date)) return reject(new Error("Data inválida"));
          resolve({ username, exists: true, data: date });
        });
    });
  });
}

export function isExpired(obj) {
  if (!obj || !obj.data) return false;
  const date = obj.data instanceof Date ? obj.data : new Date(obj.data);
  if (isNaN(date)) throw new Error("Data inválida");
  return date < new Date();
}

export async function listarUsuarios() {
  try {
    const command = `
      for file in /etc/SSHPlus/senha/*; do
        [ -f "$file" ] && echo "$(basename "$file") $(cat "$file")"
      done
    `;
    const output = await executarComandoSSH(command);
    return output
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [username, ...passArr] = l.trim().split(" ");
        return { username, password: passArr.join(" ") };
      });
  } catch (err) {
    console.error("Erro ao listar usuários:", err);
    return [];
  }
}
