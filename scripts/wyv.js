/**
 * Wyv — RPG Assistant para FoundryVTT
 *
 * Intercepta mensagens no chat que começam com @wyv,
 * coleta o contexto do token selecionado e consulta a API Wyv.
 */

const MODULE_ID = "wyv";

// ─── Registro de Settings ────────────────────────────────────────────────────

Hooks.once("init", () => {
  // URL base da API (somente GM pode alterar)
  game.settings.register(MODULE_ID, "apiUrl", {
    name: "URL da API Wyv",
    hint: "Endereço do backend. Ex: http://localhost:8000 ou https://foundry-wyv-api.azurewebsites.net",
    scope: "world",
    config: true,
    type: String,
    default: "http://localhost:8000",
  });

  // API Key para autenticação (somente GM pode alterar)
  game.settings.register(MODULE_ID, "apiKey", {
    name: "API Key (X-API-Key)",
    hint: "Chave secreta configurada no WYV_API_KEY do backend. Deixe vazio se auth estiver desabilitada.",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });

  // Idioma das respostas (cada jogador pode mudar o seu)
  game.settings.register(MODULE_ID, "language", {
    name: "Idioma das respostas",
    hint: "Código do idioma para as respostas do Wyv. Ex: pt-BR, en-US, es-ES",
    scope: "client",
    config: true,
    type: String,
    default: "pt-BR",
  });

  console.log(`${MODULE_ID} | Módulo inicializado.`);
});

// ─── Interceptação do Chat ───────────────────────────────────────────────────

Hooks.on("chatMessage", (chatLog, message, data) => {
  const trigger = "@wyv ";

  if (!message.toLowerCase().startsWith(trigger)) {
    return true; // deixa a mensagem passar normalmente
  }

  const userMessage = message.slice(trigger.length).trim();

  if (!userMessage) {
    ui.notifications.warn("Wyv | Escreva uma pergunta após @wyv.");
    return false;
  }

  // Dispara a consulta e suprime a mensagem original do chat
  _handleWyvRequest(userMessage);
  return false;
});

// ─── Lógica principal ────────────────────────────────────────────────────────

async function _handleWyvRequest(userMessage) {
  const apiUrl    = game.settings.get(MODULE_ID, "apiUrl").replace(/\/$/, "");
  const apiKey    = game.settings.get(MODULE_ID, "apiKey");
  const language  = game.settings.get(MODULE_ID, "language");

  // Monta o payload
  const payload = {
    message:     userMessage,
    language:    language,
    userName:    game.user.name,
    worldName:   game.world.title,
    systemId:    game.system.id,
    actorContext: _getActorContext(),
  };

  // Feedback visual enquanto aguarda
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

    // Remove a mensagem de "pensando..." e exibe a resposta
    await waitingMsg?.delete();
    await _postChatMessage(_formatResponse(userMessage, data.answer));

  } catch (error) {
    console.error(`${MODULE_ID} | Erro ao consultar API:`, error);
    await waitingMsg?.delete();
    await _postChatMessage(
      `<span class="wyv-error">⚠️ Wyv não conseguiu responder: ${error.message}</span>`
    );
  }
}

// ─── Contexto do Personagem ───────────────────────────────────────────────────

function _getActorContext() {
  // Usa o token selecionado no canvas
  const token = canvas.tokens?.controlled?.[0];
  const actor = token?.actor;

  if (!actor) return null;

  const sys = actor.system;

  // Extrai dados genéricos que funcionam para dnd5e e sistemas similares
  const context = { name: actor.name };

  // Nível e classe (dnd5e 5.5 e versões anteriores)
  if (sys.details?.level !== undefined) {
    context.level = sys.details.level;
  } else if (sys.details?.cr !== undefined) {
    context.cr = sys.details.cr;
  }

  // Classe principal (primeiro item do tipo 'class')
  const classItem = actor.items?.find((i) => i.type === "class");
  if (classItem) context.class = classItem.name;

  // Espécie/raça
  context.species =
    sys.details?.species?.value ??
    sys.details?.species ??
    sys.details?.race ??
    null;

  // Atributos (abilities)
  if (sys.abilities) {
    context.abilities = {};
    for (const [key, val] of Object.entries(sys.abilities)) {
      context.abilities[key] = {
        value: val.value,
        mod:   val.mod,
      };
    }
  }

  // HP
  if (sys.attributes?.hp) {
    context.hp = {
      value: sys.attributes.hp.value,
      max:   sys.attributes.hp.max,
    };
  }

  // CA
  if (sys.attributes?.ac?.value !== undefined) {
    context.ac = sys.attributes.ac.value;
  }

  // Remove chaves com valor null/undefined para deixar o payload limpo
  return _cleanObject(context);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Posta uma mensagem OOC no chat como Wyv.
 * @param {string}  content   HTML da mensagem
 * @param {boolean} temporary Não exibe som de notificação
 */
async function _postChatMessage(content, temporary = false) {
  const msgData = {
    content,
    speaker: { alias: "🐉 Wyv" },
    // OOC = "Out of Character" — mensagem discreta fora do roleplay
    type: CONST.CHAT_MESSAGE_TYPES?.OOC ?? CONST.CHAT_MESSAGE_STYLES?.OOC ?? 2,
    sound: temporary ? null : CONFIG.sounds.notification,
    flags: { [MODULE_ID]: { isWyvMessage: true } },
  };

  return ChatMessage.create(msgData);
}

/** Formata a resposta final com a pergunta original para contexto */
function _formatResponse(question, answer) {
  return `
    <div class="wyv-response">
      <div class="wyv-question">❓ ${question}</div>
      <div class="wyv-answer">${_markdownToHtml(answer)}</div>
    </div>
  `;
}

/** Converte markdown simples para HTML (bold, italic, listas) */
function _markdownToHtml(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g,     "<em>$1</em>")
    .replace(/^- (.+)$/gm,     "<li>$1</li>")
    .replace(/(<li>.*<\/li>)/s, "<ul>$1</ul>")
    .replace(/\n/g,            "<br>");
}

/** Remove recursivamente chaves null/undefined de um objeto */
function _cleanObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)
  );
}
