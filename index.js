const express = require('express');
const path = require('path');
const cors = require('cors');
const session = require('express-session');
const { createServer } = require("http");
const { Server } = require("socket.io");
const app = express();
const { online, alterarData, NewUserVPN, listarUsuarios, infoLogin, removerUsuarioSSH } = require("./src/sshAccountManager.js");

const PORT = 9001;
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ======= CONFIGURAÇÃO DA SESSÃO =======
app.use(session({
  secret: 'segredo-super-seguro', // altere isso por algo mais forte em produção
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 } // sessão dura 1 hora
}));

// ======= FUNÇÃO DE LOGIN SIMPLES =======
function logar(email, password) {
  return new Promise((resolve, reject) => {
    if (email === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD) {
      resolve();
    } else {
      reject(new Error("Credenciais inválidas"));
    }
  });
}

// ======= MIDDLEWARE PARA PROTEGER ROTAS =======
function proteger(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  res.status(401).sendFile(path.join(__dirname, 'public', 'login.html')); // redireciona para o login
}

// ======= ROTA DE LOGIN =======
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email e senha são obrigatórios." });

  try {
    await logar(email, password);
    req.session.authenticated = true;
    res.json({ success: true, message: "Login realizado com sucesso!" });
  } catch (err) {
    res.status(401).json({ error: "Credenciais inválidas." });
  }
});

// ======= ROTA DE LOGOUT =======
app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true, message: "Sessão encerrada." });
  });
});

// ======= ROTA PÚBLICA (LOGIN) =======
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ======= ROTA PROTEGIDA =======
app.get('/painel', proteger, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'painel.html'));
});

// ======= SOCKET.IO =======
io.on("connection", (socket) => {
  console.log("🟢 Novo cliente conectado:", socket.id);

  socket.on("getOnline", async () => {
    const usuariosOnline = await online();
    socket.emit("onlineData", usuariosOnline);
  });

  socket.on("criarUsuario", async (data) => {
    const { usuario, senha, dias } = data;
    console.log("Dados recebidos para criar usuário:", data);

    try {
      const hoje = new Date();
      hoje.setDate(hoje.getDate() + dias);
      const formattedExpDate = hoje.toISOString().split('T')[0];

      const result = await NewUserVPN({
        user: usuario,
        password: senha,
        days: dias,
        limit: 1,
        expDate: formattedExpDate,
      });

      const resultWithExp = { ...result, expDate: formattedExpDate };
      console.log("Usuário criado com sucesso:", resultWithExp);
      socket.emit("usuarioCriado", resultWithExp);
    } catch (error) {
      console.log("Erro ao criar usuário:", error);
      socket.emit("erroCriarUsuario", error.message);
    }
  });

  socket.on("alterarData", async (data) => {
    const { usuario, dias } = data;
    try {
      const result = await alterarData(usuario, dias);
      if (result.trim().includes("not exist")) {
        socket.emit("error", "Usuário não encontrado.");
        return;
      }
      socket.emit("dataAlterada", result);
    } catch (error) {
      socket.emit("erroAlterarData", error.message);
    }
  });

  socket.on("alterarSenha", async (data) => {
    const { usuario, senha, days } = data;
    try {
      const result = await alterarSenha({ user: usuario, pass: senha, days: days });
      if (result.trim().includes("not exist")) {
        socket.emit("error", "Usuário não encontrado.");
        return;
      }
      socket.emit("sucess", result);
    } catch (error) {
      socket.emit("erroAlterarSenha", error.message);
    }
  });

  socket.on("infoLogin", async (data) => {
    const { usuario } = data;
    try {
      const result = await infoLogin(usuario);
      socket.emit("infoLoginData", result);
    } catch (error) {
      socket.emit("erroInfoLogin", error.message);
    }
  });

  socket.on("removerUsuario", async (data) => {
    try {
      const { usuario } = data;
      if (!usuario)
        return socket.emit("erroRemoverUsuario", { message: "Nome de usuário não fornecido para exclusão." });

      const result = await removerUsuarioSSH(usuario);
      socket.emit("usuarioRemovido", { message: `Usuário '${usuario}' foi removido com sucesso!` });
    } catch (error) {
      socket.emit("erroRemoverUsuario", { message: `Falha ao remover o usuário: ${error.message}` });
    }
  });

  socket.on("listarUsuarios", async () => {
    try {
      const usuarios = await listarUsuarios();
      socket.emit("usuariosListados", usuarios);
    } catch (error) {
      socket.emit("erroListarUsuarios", error.message);
    }
  });

  socket.on("disconnect", () => {
    console.log("🔴 Cliente desconectado:", socket.id);
  });
});

module.exports = app;
