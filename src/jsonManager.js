import { Client } from "ssh2";
import dotenv from "dotenv";

dotenv.config();

const connSettings = {
  host: process.env.SSH_IP,
  port: Number(process.env.SSH_PORT) || 22,
  username: process.env.SSH_USER,
  password: process.env.SSH_PASSWORD,
  readyTimeout: 45000,
  handshakeTimeout: 45000,
};

const remoteFilePath = "/usr/local/etc/xray/config.json";

/**
 * Cria e retorna uma nova conexão SSH pronta para uso.
 * @returns {Promise<Client>}
 */
function conectarSSH() {
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

/**
 * Lê e retorna o conteúdo JSON remoto.
 * @returns {Promise<object>}
 */
export async function lerJson() {
  const conn = await conectarSSH();
  try {
    const sftp = await new Promise((resolve, reject) =>
      conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
    );

    const data = await new Promise((resolve, reject) =>
      sftp.readFile(remoteFilePath, "utf8", (err, content) =>
        err ? reject(err) : resolve(content)
      )
    );

    return JSON.parse(data);
  } catch (err) {
    throw new Error(`Falha ao ler JSON remoto: ${err.message}`);
  } finally {
    conn.end();
  }
}

/**
 * Salva um objeto como JSON no servidor remoto.
 * @param {object} jsonData - Dados a salvar.
 * @param {boolean} [compact=false] - Define se o JSON deve ser minificado.
 */
export async function SalvarJson(jsonData, compact = false) {
  const conn = await conectarSSH();
  try {
    const sftp = await new Promise((resolve, reject) =>
      conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
    );

    const jsonString = JSON.stringify(jsonData, null, compact ? 0 : 2);

    await new Promise((resolve, reject) =>
      sftp.writeFile(remoteFilePath, jsonString, (err) =>
        err ? reject(err) : resolve()
      )
    );

    console.log("✅ JSON remoto salvo com sucesso");
  } catch (err) {
    throw new Error(`Falha ao salvar JSON remoto: ${err.message}`);
  } finally {
    conn.end();
  }
}
