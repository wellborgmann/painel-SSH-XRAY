import { Client } from "ssh2";
import dotenv from "dotenv";

dotenv.config();

const connSettings = {
  host: process.env.SSH_IP,
  port: process.env.SSH_PORT,
  username: process.env.SSH_USER,
  password: process.env.SSH_PASSWORD,
  readyTimeout: 60000,
};

const remoteFilePath = "/usr/local/etc/xray/config.json";

/**
 * Lê e analisa o arquivo JSON remotamente via SFTP.
 * @returns {Promise<object>} O objeto JavaScript analisado a partir do JSON remoto.
 */
async function lerJson() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on("ready", () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return reject(err);
          }

          sftp.readFile(remoteFilePath, "utf8", (err, data) => {
            conn.end();
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

    conn.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Serializa um objeto JavaScript em JSON e o salva remotamente via SFTP.
 * @param {object} jsonData O objeto JavaScript a ser salvo.
 * @returns {Promise<void>} Uma Promise que resolve quando o arquivo é salvo.
 */
function SalvarJson(jsonData) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const tempFilePath = remoteFilePath; // Mantém o nome da variável como no original

    conn.on("error", (err) => {
      conn.end();
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
              if (err) {
                conn.end();
                return reject(err);
              }

              conn.end();
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