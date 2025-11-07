import { Client } from "ssh2";
import dotenv from "dotenv";

dotenv.config();

// Aumentamos o timeout para 45 segundos para maior estabilidade em ambientes serverless
const connSettings = {
  host: process.env.SSH_IP,
  port: process.env.SSH_PORT,
  username: process.env.SSH_USER,
  password: process.env.SSH_PASSWORD,
  readyTimeout: 45000,          // Tempo limite para o status 'ready'
  handshakeTimeout: 45000       // Tempo limite para o handshake inicial
};

const remoteFilePath = "/usr/local/etc/xray/config.json";

/**
 * Lê e analisa o arquivo JSON remotamente via SFTP.
 * @returns {Promise<object>} O objeto JavaScript analisado a partir do JSON remoto.
 */
async function lerJson() {
  return new Promise((resolve, reject) => {
    const conn = new Client(); // Nova conexão
    
    conn.on("error", (err) => {
      conn.end(); // CRÍTICO: Encerra em caso de erro
      reject(err);
    });

    conn
      .on("ready", () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return reject(err);
          }

          sftp.readFile(remoteFilePath, "utf8", (err, data) => {
            conn.end(); // CRÍTICO: Encerra após a leitura
            if (err) {
              return reject(err);
            }

            try {
              const jsonData = JSON.parse(data);
              resolve(jsonData);
            } catch (parseError) {
              reject(parseError);
            }
          });
        });
      })
      .connect(connSettings);
  });
}

/**
 * Serializa um objeto JavaScript em JSON e o salva remotamente via SFTP.
 * @param {object} jsonData O objeto JavaScript a ser salvo.
 * @returns {Promise<void>} Uma Promise que resolve quando o arquivo é salvo.
 */
function SalvarJson(jsonData) {
  return new Promise((resolve, reject) => {
    const conn = new Client(); // Nova conexão
    const tempFilePath = remoteFilePath;

    conn.on("error", (err) => {
      conn.end(); // CRÍTICO: Encerra em caso de erro
      reject(err);
    });

    conn
      .on("ready", function () {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return reject(err);
          }

          sftp.writeFile(
            tempFilePath,
            JSON.stringify(jsonData, null, 2),
            async (err) => {
              conn.end(); // CRÍTICO: Encerra após a escrita
              if (err) {
                return reject(err);
              }

              console.log("Json v2 Salvo");
              resolve();
            }
          );
        });
      })
      .connect(connSettings);
  });
}

export { lerJson, SalvarJson };