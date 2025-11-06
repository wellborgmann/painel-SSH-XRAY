import express from 'express';
import path from 'path';
import cors from 'cors';
import session from 'express-session';
import { fileURLToPath } from 'url';

// --- Dependências para Sessão Persistente (Redis) ---
// CORREÇÃO: Usaremos require para carregar o módulo CommonJS connect-redis de forma confiável.
import { createRequire } from 'module';
const require = createRequire(import.meta.url); 

import { createClient } from 'redis';

// Note: A função 'alterarSenha' não foi importada no código original, 
// então a adicionei aqui, mas ela deve estar em './src/sshAccountManager.js'.
import { 
    online, 
    alterarData, 
    NewUserVPN, 
    listarUsuarios, 
    infoLogin, 
    removerUsuarioSSH,
    alterarSenha // Presumindo que esta função existe no manager
} from './src/sshAccountManager.js';

// ======= FIX PARA __dirname EM ES MODULES =======
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ====================================================
// ======= CONFIGURAÇÃO DE SESSÃO COM REDIS (PRODUÇÃO) =======
// ====================================================

// 1. Configurar Cliente Redis
const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.log('Redis Client Error:', err));

// VARIÁVEL REDIS STORE: Inicialmente indefinida. Se o try/catch for bem-sucedido, ela será preenchida.
let redisStore; 

// 2. Criar o Redis Store (Armazenamento Persistente)
try {
    const RedisStoreFactory = require('connect-redis');
    
    // Tentativa robusta de extrair e chamar a função construtora.
    // Usamos um fallback seguro: ou a função está no .default ou é o objeto raiz.
    const ConnectRedisStore = RedisStoreFactory.default || RedisStoreFactory; 

    // Verificação de segurança final: se não for uma função, lançamos um erro de tipagem.
    if (typeof ConnectRedisStore !== 'function') {
        throw new TypeError("ConnectRedisStore não é uma função. Problema de importação CJS/ESM.");
    }
    
    // Chamar a função factory com o express-session para obter o Store Constructor
    const RedisStoreConstructor = ConnectRedisStore(session); 

    // Instanciar o Store
    redisStore = new RedisStoreConstructor({
      client: redisClient,
      prefix: 'painel_sess:',
    });

} catch (error) {
    console.error("❌ ERRO CRÍTICO ao configurar connect-redis:", error.message);
    console.warn("Retornando ao MemoryStore do Express. (Risco de estabilidade em produção!)");
    // redisStore permanece undefined, o que faz o app.use(session) usar o MemoryStore padrão.
}

// Função de Inicialização Principal (Async para await redisClient.connect())
async function initializeApp() {

    // Se o RedisStore foi configurado com sucesso (sem erro de importação), tentamos conectar.
    if (redisStore) {
        try {
            await redisClient.connect(); 
            console.log("Conexão Redis estabelecida com sucesso.");
        } catch (error) {
            console.warn("❌ Falha na conexão física com o Redis. Usando MemoryStore como fallback.");
            redisStore = undefined; // Força o fallback se a conexão falhar
        }
    }


    // 3. Aplicar ao Express
    app.use(session({
      store: redisStore, // Usa Redis se configurado e conectado, ou MemoryStore se falhar
      secret: process.env.SESSION_SECRET || 'segredo-super-seguro-padrao', // Usar env é OBRIGATÓRIO
      resave: false,
      saveUninitialized: false,
      cookie: { 
        maxAge: 1000 * 60 * 60, // 1 hora
        secure: process.env.NODE_ENV === 'production' // true apenas se estiver rodando em HTTPS (produção)
      }
    }));


    // ======= LOGIN =======
    function logar(email, password) {
      return new Promise((resolve, reject) => {
        // Use process.env.ADMIN_USER e process.env.ADMIN_PASSWORD
        if (email === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD) {
          resolve();
        } else {
          reject(new Error("Credenciais inválidas"));
        }
      });
    }

    function proteger(req, res, next) {
      if (req.session && req.session.authenticated) return next();
      // Garante que o usuário seja redirecionado para o login se não estiver autenticado
      res.status(401).sendFile(path.join(__dirname, 'public', 'login.html'));
    }

    // ======= ROTAS DE LOGIN =======
    app.post('/login', async (req, res) => {
      const { email, password } = req.body;
      if (!email || !password)
        return res.status(400).json({ error: "Email e senha são obrigatórios." });

      try {
        await logar(email, password);
        req.session.authenticated = true;
        res.json({ success: true });
      } catch (err) {
        res.status(401).json({ error: "Credenciais inválidas." });
      }
    });

    app.post('/logout', (req, res) => {
      req.session.destroy((err) => {
          if (err) {
              return res.status(500).json({ success: false, error: "Falha ao encerrar a sessão." });
          }
          res.json({ success: true });
      });
    });

    // ======= ROTAS PÚBLICAS E PROTEGIDAS =======
    app.get('/', (req, res) => {
        // Redireciona para o painel se já estiver logado
        if (req.session && req.session.authenticated) {
            return res.redirect('/painel');
        }
        res.sendFile(path.join(__dirname, 'public', 'login.html'));
    });
    
    app.get('/painel', proteger, (req, res) => res.sendFile(path.join(__dirname, 'public', 'painel.html')));  

    // ======= ROTAS API (PROTEGIDAS) =======
    // Todas as rotas API devem ser protegidas
    
    app.get('/api/online', proteger, async (req, res) => {
      try {
        const usuarios = await online();
        res.json(usuarios);
      } catch (err) {
        console.error('Erro /api/online:', err.message);
        res.status(500).json({ error: err.message });
      }
    });

    app.post('/api/criarUsuario', proteger, async (req, res) => {
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
        console.error('Erro /api/criarUsuario:', error.message);
        res.status(500).json({ error: error.message });
      }
    });

    app.post('/api/alterarData', proteger, async (req, res) => {
      try {
        const { usuario, dias } = req.body;
        const result = await alterarData(usuario, dias);
        res.json({ result });
      } catch (error) {
        console.error('Erro /api/alterarData:', error.message);
        res.status(500).json({ error: error.message });
      }
    });

    app.post('/api/alterarSenha', proteger, async (req, res) => {
      try {
        const { usuario, senha, days } = req.body;
        // O nome da função deve ser 'alterarSenha'
        const result = await alterarSenha({ user: usuario, pass: senha, days });
        res.json({ result });
      } catch (error) {
        console.error('Erro /api/alterarSenha:', error.message);
        res.status(500).json({ error: error.message });
      }
    });

    app.post('/api/infoLogin', proteger, async (req, res) => {
      try {
        const { usuario } = req.body;
        const result = await infoLogin(usuario);
        res.json(result);
      } catch (error) {
        console.error('Erro /api/infoLogin:', error.message);
        res.status(500).json({ error: error.message });
      }
    });

    app.post('/api/removerUsuario', proteger, async (req, res) => {
      try {
        const { usuario } = req.body;
        await removerUsuarioSSH(usuario);
        res.json({ success: true, message: `Usuário '${usuario}' removido.` });
      } catch (error) {
        console.error('Erro /api/removerUsuario:', error.message);
        res.status(500).json({ error: error.message });
      }
    });

    app.get('/api/listarUsuarios', proteger, async (req, res) => {
      try {
        const usuarios = await listarUsuarios();
        res.json(usuarios);
      } catch (error) {
        console.error('Erro /api/listarUsuarios:', error.message);
        res.status(500).json({ error: error.message });
      }
    });

    // ====================================================
    // ======= INICIALIZAÇÃO E LISTEN DO SERVIDOR =======
    // ====================================================

    // Correção de erro na inicialização e ajuste para o ambiente de deploy (Render, etc.)



    // Teste de conexão inicial ou outras operações assíncronas
    (async () => {
       try {
        const usuarios = await listarUsuarios();
        console.log("Lista de usuários SSH na inicialização:", JSON.stringify(usuarios, null, 2));
      } catch (error) {
       // Este erro geralmente é o ETIMEDOUT ou Invalid Username, confirme suas credenciais SSH.
       console.log('Erro ao listar usuários na inicialização (Verifique suas credenciais SSH):', error.message);
      }
    })();
}
export default app;
// Inicia a aplicação
initializeApp();

// Remover o 'export default app;' para garantir que ele rode como um servidor persistente.