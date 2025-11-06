const express = require('express');
const path = require('path');
const cors = require('cors');
const session = require('express-session');
const app = express();
const { online, alterarData, NewUserVPN, listarUsuarios, infoLogin, removerUsuarioSSH } = require("./src/sshAccountManager.js");

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ======= CONFIG SESSÃO =======
app.use(session({
  secret: 'segredo-super-seguro',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 }
}));

// ======= LOGIN =======
function logar(email, password) {
  return new Promise((resolve, reject) => {
    if (email === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD) {
      resolve();
    } else {
      reject(new Error("Credenciais inválidas"));
    }
  });
}

function proteger(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).sendFile(path.join(__dirname, 'public', 'login.html'));
}

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email e senha são obrigatórios." });

  try {
    await logar(email, password);
    req.session.authenticated = true;
    res.json({ success: true });
  } catch {
    res.status(401).json({ error: "Credenciais inválidas." });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ======= ROTAS PÚBLICAS E PROTEGIDAS =======
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/painel', proteger, (req, res) => res.sendFile(path.join(__dirname, 'public', 'painel.html')));

// ======= ROTAS API (substituindo o Socket.IO) =======
app.get('/api/online', async (req, res) => {
  try {
    const usuarios = await online();
    res.json(usuarios);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/criarUsuario', async (req, res) => {
  try {
    const { usuario, senha, dias } = req.body;
    const hoje = new Date();
    hoje.setDate(hoje.getDate() + dias);
    const expDate = hoje.toISOString().split('T')[0];

    const result = await NewUserVPN({
      user: usuario,
      password: senha,
      days: dias,
      limit: 1,
      expDate
    });

    res.json({ ...result, expDate });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/alterarData', async (req, res) => {
  try {
    const { usuario, dias } = req.body;
    const result = await alterarData(usuario, dias);
    res.json({ result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/alterarSenha', async (req, res) => {
  try {
    const { usuario, senha, days } = req.body;
    const result = await alterarSenha({ user: usuario, pass: senha, days });
    res.json({ result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/infoLogin', async (req, res) => {
  try {
    const { usuario } = req.body;
    const result = await infoLogin(usuario);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/removerUsuario', async (req, res) => {
  try {
    const { usuario } = req.body;
    await removerUsuarioSSH(usuario);
    res.json({ success: true, message: `Usuário '${usuario}' removido.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/listarUsuarios', async (req, res) => {
  try {
    const usuarios = await listarUsuarios();
    res.json(usuarios);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = app;
