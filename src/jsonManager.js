const { Client } = require("ssh2");
const dotenv = require("dotenv");
dotenv.config();
const connSettings = {
  host: "157.254.54.234",
  port: 22,
  username: "root",
  password: "7093dado7093",
  readyTimeout: 60000,
};

const remoteFilePath = "/usr/local/etc/xray/config.json";

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

function SalvarJson(jsonData) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const tempFilePath = remoteFilePath;

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

module.exports = {
  lerJson,
  SalvarJson,
};
