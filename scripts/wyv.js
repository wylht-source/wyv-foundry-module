/**
 * Wyv — RPG Assistant para FoundryVTT
 *
 * Intercepta mensagens no chat que começam com @wyv,
 * coleta o contexto do token selecionado, reconstrói o histórico
 * a partir do chat do Foundry e consulta a API Wyv.
 */

const MODULE_ID = "wyv";

// ─── Traduções ────────────────────────────────────────────────────────────────

const TRANSLATIONS = {
  "pt-BR": {
    // Settings
    "settings.apiUrl.name":       "URL da API Wyv",
    "settings.apiUrl.hint":       "Endereço do backend. Ex: http://localhost:8000 ou https://foundry-wyv-api.azurewebsites.net",
    "settings.apiKey.name":       "API Key (X-API-Key)",
    "settings.apiKey.hint":       "Chave secreta configurada no WYV_API_KEY do backend. Deixe vazio para desabilitar autenticação.",
    "settings.language.name":     "Idioma das respostas",
    "settings.language.hint":     "Idioma usado nas respostas e na interface do Wyv. Ex: pt-BR, en",
    "settings.historySize.name":  "Tamanho do histórico",
    "settings.historySize.hint":  "Número de trocas anteriores enviadas como contexto ao LLM. 0 desativa o histórico.",
    // Notificações
    "notify.typeQuestion":        "Wyv | Digite uma pergunta após @wyv.",
    // Chat
    "chat.thinking":              "🐉 Wyv está pensando...",
    "chat.error":                 "⚠️ Wyv não conseguiu responder",
  },
  "en": {
    // Settings
    "settings.apiUrl.name":       "Wyv API URL",
    "settings.apiUrl.hint":       "Backend address. E.g.: http://localhost:8000 or https://foundry-wyv-api.azurewebsites.net",
    "settings.apiKey.name":       "API Key (X-API-Key)",
    "settings.apiKey.hint":       "Secret key configured in WYV_API_KEY on the backend. Leave empty to disable authentication.",
    "settings.language.name":     "Response Language",
    "settings.language.hint":     "Language used for Wyv responses and interface. E.g.: pt-BR, en",
    "settings.historySize.name":  "History Size",
    "settings.historySize.hint":  "Number of previous exchanges sent as context to the LLM. Set to 0 to disable history.",
    // Notifications
    "notify.typeQuestion":        "Wyv | Please type a question after @wyv.",
    // Chat
    "chat.thinking":              "🐉 Wyv is thinking...",
    "chat.error":                 "⚠️ Wyv could not respond",
  },
};

/**
 * Retorna a string traduzida com base no setting `language` do módulo.
 * Fallback para inglês se a chave não existir no idioma configurado.
 */
function t(key) {
  let lang;
  try {
    lang = game.settings.get(MODULE_ID, "language") || "en";
  } catch {
    lang = "en";
  }

  // Normaliza: "pt-BR" → "pt-BR", qualquer outra coisa → "en"
  const resolved = TRANSLATIONS[lang] ? lang : "en";
  return TRANSLATIONS[resolved]?.[key] ?? TRANSLATIONS["en"]?.[key] ?? key;
}

// ─── Registro de Settings ────────────────────────────────────────────────────

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "apiUrl", {
    name:    "Wyv API URL",
    hint:    "Backend URL.",
    scope:   "world",
    config:  true,
    type:    String,
    default: "http://localhost:8000",
    onChange: () => {},
  });

  game.settings.register(MODULE_ID, "apiKey", {
    name:    "API Key (X-API-Key)",
    hint:    "Secret key for backend authentication.",
    scope:   "world",
    config:  true,
    type:    String,
    default: "",
  });

  game.settings.register(MODULE_ID, "language", {
    name:    "Language / Idioma",
    hint:    "Interface and response language. Ex: pt-BR, en",
    scope:   "client",
    config:  true,
    type:    String,
    default: "pt-BR",
  });

  game.settings.register(MODULE_ID, "historySize", {
    name:    "History Size",
    hint:    "Number of previous exchanges sent as context. 0 = disabled.",
    scope:   "world",
    config:  true,
    type:    Number,
    range:   { min: 0, max: 20, step: 1 },
    default: 5,
  });

  // Após o init, atualiza os labels das settings com o idioma configurado
  Hooks.once("ready", _updateSettingLabels);

  console.log(`${MODULE_ID} | Module initialized.`);
});

/**
 * Atualiza os labels e hints das settings com base no idioma do módulo.
 * O Foundry já renderizou o painel, então atualizamos os textos via DOM
 * na próxima vez que o painel for aberto — re-registramos as settings
 * com os nomes traduzidos.
 */
function _updateSettingLabels() {
  const keys = ["apiUrl", "apiKey", "language", "historySize"];
  for (const key of keys) {
    const setting = game.settings.settings.get(`${MODULE_ID}.${key}`);
    if (setting) {
      setting.name = t(`settings.${key}.name`);
      setting.hint = t(`settings.${key}.hint`);
    }
  }
}

// ─── Interceptação do Chat ───────────────────────────────────────────────────

Hooks.on("chatMessage", (chatLog, message, data) => {
  const trigger = "@wyv ";

  if (!message.toLowerCase().startsWith(trigger)) {
    return true;
  }

  const userMessage = message.slice(trigger.length).trim();

  if (!userMessage) {
    ui.notifications.warn(t("notify.typeQuestion"));
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
    `<em>${t("chat.thinking")}</em>`,
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
    await _postChatMessage(
      _formatResponse(userMessage, data.answer),
      false,
      { question: userMessage, answer: data.answer }
    );

  } catch (error) {
    console.error(`${MODULE_ID} | API error:`, error);
    await waitingMsg?.delete();

    // Extrai a mensagem de erro de forma segura independente do tipo
    const errMsg =
      typeof error === "string"
        ? error
        : error?.message || error?.detail || JSON.stringify(error) || "Unknown error";

    await _postChatMessage(
      `<span class="wyv-error">${t("chat.error")}: ${errMsg}</span>`
    );
  }
}

// ─── Histórico ────────────────────────────────────────────────────────────────

function _buildHistory(historySize) {
  if (historySize <= 0) return [];

  const wyvMessages = game.messages.contents.filter(
    (msg) =>
      msg.flags?.[MODULE_ID]?.question &&
      msg.flags?.[MODULE_ID]?.answer
  );

  const recent = wyvMessages.slice(-historySize);

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

  const sys     = actor.system;
  const context = { name: actor.name };

  if (sys.details?.level !== undefined) {
    context.level = sys.details.level;
  } else if (sys.details?.cr !== undefined) {
    context.cr = sys.details.cr;
  }

  const classItem = actor.items?.find((i) => i.type === "class");
  if (classItem) context.class = classItem.name;

  // dnd5e 5.0+ retorna species como objeto completo da raça — extrai só o nome
  const speciesRaw = sys.details?.species ?? sys.details?.race ?? null;
  if (typeof speciesRaw === "string") {
    context.species = speciesRaw;
  } else if (speciesRaw?.name) {
    context.species = speciesRaw.name;
  } else if (typeof speciesRaw?.value === "string") {
    context.species = speciesRaw.value;
  } else {
    context.species = null;
  }

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

async function _postChatMessage(content, temporary = false, wyvFlags = null) {
  // Compatível com Foundry v11, v12 e v13
  const isV13 = game.release?.generation >= 13;

  const msgData = {
    content,
    speaker: ChatMessage.getSpeaker({ alias: "(IA) Wyv" }),
    sound:   temporary ? null : CONFIG.sounds.notification,
    flags: {
      [MODULE_ID]: {
        isWyvMessage: true,
        ...wyvFlags,
      },
    },
  };

  // v13 usa 'style', versões anteriores usam 'type'
  if (isV13) {
    msgData.style = CONST.CHAT_MESSAGE_STYLES?.OOC ?? 2;
  } else {
    msgData.type = CONST.CHAT_MESSAGE_TYPES?.OOC ?? 2;
  }

  return ChatMessage.create(msgData);
}

function _formatResponse(question, answer) {
  return `
    <div class="wyv-response">
      <div class="wyv-header">🐉 (IA) Wyv</div>
      <div class="wyv-question">❓ ${question}</div>
      <div class="wyv-answer">${_markdownToHtml(answer)}</div>
    </div>
  `;
}

function _markdownToHtml(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g,  "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g,      "<em>$1</em>")
    .replace(/^- (.+)$/gm,      "<li>$1</li>")
    .replace(/(<li>.*<\/li>)/s, "<ul>$1</ul>")
    .replace(/\n/g,             "<br>");
}

function _cleanObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)
  );
}