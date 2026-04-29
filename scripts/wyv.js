/**
 * Wyv — RPG Assistant para FoundryVTT
 *
 * Intercepta mensagens no chat que começam com @wyv,
 * coleta o contexto do token selecionado, reconstrói o histórico
 * a partir do chat do Foundry e consulta a API Wyv.
 */

const MODULE_ID = "wyv";

// ─── Registro de Settings ────────────────────────────────────────────────────

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "apiUrl", {
    name: "URL da API Wyv",
    hint: "Endereço do backend. Ex: http://localhost:8000 ou https://foundry-wyv-api.azurewebsites.net",
    scope: "world",
    config: true,
    type: String,
    default: "http://localhost:8000",
  });

  game.settings.register(MODULE_ID, "apiKey", {
    name: "API Key (X-API-Key)",
    hint: "Chave secreta configurada no WYV_API_KEY do backend. Deixe vazio se auth estiver desabilitada.",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "language", {
    name: "Idioma das respostas",
    hint: "Código do idioma para as respostas do Wyv. Ex: pt-BR, en-US, es-ES",
    scope: "client",
    config: true,
    type: String,
    default: "pt-BR",
  });

  game.settings.register(MODULE_ID, "historySize", {
    name: "Tamanho do histórico",
    hint: "Número de trocas anteriores com o Wyv que serão enviadas como contexto. 0 desativa o histórico.",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 0, max: 20, step: 1 },
    default: 5,
  });

  console.log(`${MODULE_ID} | Módulo inicializado.`);
});

// ─── Interceptação do Chat ───────────────────────────────────────────────────

Hooks.on("chatMessage", (chatLog, message, data) => {
  const trigger = "@wyv ";

  if (!message.toLowerCase().startsWith(trigger)) {
    return true;
  }

  const userMessage = message.slice(trigger.length).trim();

  if (!userMessage) {
    ui.notifications.warn("Wyv | Escreva uma pergunta após @wyv.");
    return false;
  }

  _handleWyvRequest(userMessage);
  return false;
});

// ─── Lógica principal ────────────────────────────────────────────────────────

async function _handleWyvRequest(userMessage) {
  const apiUrl      = game.settings.get(MODULE_ID, "apiUrl").replace(/\/$/, "");
  const apiKey      = game.settings.get(MODULE_ID, "apiKey");
  const language    = game.settings.get(MODULE_ID, "language");
  const historySize = game.settings.get(MODULE_ID, "historySize");
  const isGM        = game.user.isGM;

  const payload = {
    message:      userMessage,
    language:     language,
    userName:     game.user.name,
    worldName:    game.world.title,
    systemId:     game.system.id,
    isGM:         isGM,
    actorContext: _getActorContext(),
    history:      _buildHistory(historySize),
  };

  const waitingMsg = await _postChatMessage(
    `<em>🐉 Wyv está pensando...</em>`,
    true
  );

  try {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["X-API-Key"] = apiKey;

    const response = await fetch(`${apiUrl}/chat`, {
      method:  "POST",
      headers: headers,
      body:    JSON.stringify(payload),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${response.status}`);
    }

    const data = await response.json();

    await waitingMsg?.delete();

    // Salva question + answer nos flags para reconstruir o histórico depois
    await _postChatMessage(
      _formatResponse(userMessage, data.answer),
      false,
      { question: userMessage, answer: data.answer }
    );

  } catch (error) {
    console.error(`${MODULE_ID} | Erro ao consultar API:`, error);
    await waitingMsg?.delete();
    await _postChatMessage(
      `<span class="wyv-error">⚠️ Wyv não conseguiu responder: ${error.message}</span>`
    );
  }
}

// ─── Histórico ────────────────────────────────────────────────────────────────

/**
 * Reconstrói o histórico de conversa a partir das mensagens do chat do Foundry.
 * Filtra mensagens com flags.wyv.question e flags.wyv.answer,
 * respeitando o limite de historySize trocas.
 *
 * @param {number} historySize - Número máximo de trocas a incluir
 * @returns {Array<{role: string, content: string}>}
 */
function _buildHistory(historySize) {
  if (historySize <= 0) return [];

  // game.messages já vem ordenado do mais antigo pro mais recente
  const wyvMessages = game.messages.contents.filter(
    (msg) =>
      msg.flags?.[MODULE_ID]?.question &&
      msg.flags?.[MODULE_ID]?.answer
  );

  // Pega as últimas N trocas
  const recent = wyvMessages.slice(-historySize);

  // Monta no formato esperado pelo OpenAI: [{role, content}, ...]
  const history = [];
  for (const msg of recent) {
    history.push({ role: "user",      content: msg.flags[MODULE_ID].question });
    history.push({ role: "assistant", content: msg.flags[MODULE_ID].answer   });
  }

  return history;
}

// ─── Contexto do Personagem ───────────────────────────────────────────────────

function _getActorContext() {
  const token = canvas.tokens?.controlled?.[0];
  const actor = token?.actor;

  if (!actor) return null;

  const sys = actor.system;
  const context = { name: actor.name };

  if (sys.details?.level !== undefined) {
    context.level = sys.details.level;
  } else if (sys.details?.cr !== undefined) {
    context.cr = sys.details.cr;
  }

  const classItem = actor.items?.find((i) => i.type === "class");
  if (classItem) context.class = classItem.name;

  context.species =
    sys.details?.species?.value ??
    sys.details?.species ??
    sys.details?.race ??
    null;

  if (sys.abilities) {
    context.abilities = {};
    for (const [key, val] of Object.entries(sys.abilities)) {
      context.abilities[key] = { value: val.value, mod: val.mod };
    }
  }

  if (sys.attributes?.hp) {
    context.hp = { value: sys.attributes.hp.value, max: sys.attributes.hp.max };
  }

  if (sys.attributes?.ac?.value !== undefined) {
    context.ac = sys.attributes.ac.value;
  }

  return _cleanObject(context);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Posta uma mensagem OOC no chat como (IA) Wyv.
 * @param {string}      content    HTML da mensagem
 * @param {boolean}     temporary  Suprime som de notificação
 * @param {object|null} wyvFlags   Dados extras salvos nos flags (question/answer)
 */
async function _postChatMessage(content, temporary = false, wyvFlags = null) {
  const msgData = {
    content,
    speaker: { alias: "(IA) Wyv" },
    type: CONST.CHAT_MESSAGE_TYPES?.OOC ?? CONST.CHAT_MESSAGE_STYLES?.OOC ?? 2,
    sound: temporary ? null : CONFIG.sounds.notification,
    flags: {
      [MODULE_ID]: {
        isWyvMessage: true,
        ...wyvFlags,
      },
    },
  };

  return ChatMessage.create(msgData);
}

function _formatResponse(question, answer) {
  return `
    <div class="wyv-response">
      <div class="wyv-question">❓ ${question}</div>
      <div class="wyv-answer">${_markdownToHtml(answer)}</div>
    </div>
  `;
}

function _markdownToHtml(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g,     "<em>$1</em>")
    .replace(/^- (.+)$/gm,     "<li>$1</li>")
    .replace(/(<li>.*<\/li>)/s, "<ul>$1</ul>")
    .replace(/\n/g,            "<br>");
}

function _cleanObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)
  );
}