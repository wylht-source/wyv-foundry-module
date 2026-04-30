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
  } catch(e) {
    lang = "en";
  }

  // Normaliza: "pt-BR" → "pt-BR", qualquer outra coisa → "en"
  const resolved = TRANSLATIONS[lang] ? lang : "en";
  return TRANSLATIONS[resolved]?.[key] ?? TRANSLATIONS["en"]?.[key] ?? key;
}

// ─── Tela de Permissões de Jogadores ─────────────────────────────────────────

/**
 * Abre um Dialog simples com checkboxes por jogador.
 * Usa Dialog (compatível v11/v12/v13) em vez de FormApplication (depreciado v13).
 */
function _openPermissionsDialog() {
  const permissions = JSON.parse(game.settings.get(MODULE_ID, "playerPermissions") || "{}");
  const players     = game.users.contents.filter((u) => !u.isGM);

  if (!players.length) {
    ui.notifications.warn("Wyv | No players found in this world.");
    return;
  }

  const rows = players.map((u) => {
    const allowed = permissions[u.id] !== false;
    return `
      <div class="wyv-perm-row">
        <img src="${u.avatar || "icons/svg/mystery-man.svg"}" class="wyv-perm-avatar" />
        <span class="wyv-perm-name">${u.name}</span>
        <input type="checkbox" data-user-id="${u.id}" ${allowed ? "checked" : ""} />
      </div>`;
  }).join("");

  const content = `<div class="wyv-perm-list">${rows}</div>`;

  new Dialog({
    title:   "Wyv — Player Permissions / Permissões",
    content: content,
    buttons: {
      save: {
        icon:  '<i class="fas fa-save"></i>',
        label: "Save / Salvar",
        callback: async (html) => {
          const updated = {};
          html.find("[data-user-id]").each((_, el) => {
            updated[el.dataset.userId] = el.checked;
          });
          await game.settings.set(MODULE_ID, "playerPermissions", JSON.stringify(updated));
          ui.notifications.info("Wyv | Permissions saved.");
        },
      },
      cancel: {
        icon:  '<i class="fas fa-times"></i>',
        label: "Cancel / Cancelar",
      },
    },
    default: "save",
  }, { width: 400 }).render(true);
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

  game.settings.register(MODULE_ID, "conciseMode", {
    name: "Concise Responses / Respostas Diretas",
    hint: "When enabled, Wyv gives shorter and more direct answers. / Quando ativado, Wyv dá respostas mais curtas e diretas.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "dndEdition", {
    name: "D&D 5e Edition / Edição",
    hint: "Which D&D 5e edition your table uses. Affects which rules the AI prioritizes. / Qual edição do D&D 5e sua mesa usa.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      "none":   "Not D&D 5e / Não é D&D 5e",
      "legacy": "D&D 5e Legacy (2014)",
      "modern": "D&D 5e Modern (2024)",
    },
    default: "none",
  });

  game.settings.register(MODULE_ID, "useSrdApi", {
    name: "Query D&D 5e SRD API / Consultar API SRD",
    hint: "When enabled and edition is Legacy (2014), Wyv queries dnd5eapi.co for additional rules context. / Quando ativado e edição for Legacy (2014), Wyv consulta dnd5eapi.co para contexto adicional de regras.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "compendiumPacks", {
    name: "Compendium Packs (Rules)",
    hint: "Comma-separated pack IDs to search for rules. E.g.: dnd5e.rules,dnd5e.rules-modern — find IDs by running 'game.packs.map(p=>p.collection)' in the browser console.",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });

  // Armazena permissões como JSON: { "userId": true/false, ... }
  game.settings.register(MODULE_ID, "playerPermissions", {
    name: "Player Permissions",
    scope: "world",
    config: false,
    type: String,
    default: "{}",
  });

  // Botão na lista de settings que abre o dialog de permissões
  // Compatível com v11/v12 (Application) e v13 (ApplicationV2)
  const _WyvPermMenu = class extends (
    foundry.applications?.api?.ApplicationV2 ?? Application
  ) {
    render(...args) { _openPermissionsDialog(); }
  };

  game.settings.registerMenu(MODULE_ID, "playerPermissionsMenu", {
    name: "Player Permissions / Permissões de Jogadores",
    label: "Manage / Gerenciar",
    hint: "Allow or deny each player from using @wyv in chat. / Permitir ou negar o uso do @wyv por jogador.",
    icon: "fas fa-users",
    type: _WyvPermMenu,
    restricted: true,
  });

  game.settings.register(MODULE_ID, "npcActorFolder", {
    name: "NPC Actor Folder / Pasta de Atores NPC",
    hint: "Folder name in the Actors tab where generated NPCs will be placed. / Nome da pasta na aba Actors onde os NPCs gerados serão colocados.",
    scope: "world",
    config: true,
    type: String,
    default: "WyvIAGenerated",
  });

  game.settings.register(MODULE_ID, "generateItemImage", {
    name: "Generate Item Image",
    hint: "When enabled, Wyv generates an AI icon for each item. / Quando ativado, gera um ícone de IA para cada item criado.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "itemImageModel", {
    name: "Item Image Model / Modelo de Imagem de Item",
    hint: "AI model, resolution and quality for item icons. / Modelo, resolução e qualidade para ícones de itens.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      "dall-e-2:256x256":                "DALL-E 2 — 256×256 (est. $0.016/img) ★ padrão",
      "dall-e-2:512x512":                "DALL-E 2 — 512×512 (est. $0.018/img)",
      "dall-e-2:1024x1024":              "DALL-E 2 — 1024×1024 (est. $0.020/img)",
      "dall-e-3:1024x1024":              "DALL-E 3 — 1024×1024 standard (est. $0.040/img)",
      "dall-e-3:1024x1024:hd":          "DALL-E 3 — 1024×1024 HD (est. $0.080/img)",
      "gpt-image-1-mini:1024x1024:low":  "GPT-Image-1 Mini — 1024×1024 Low (est. $0.005/img) 🏆",
      "gpt-image-1-mini:1024x1024:medium": "GPT-Image-1 Mini — 1024×1024 Medium (est. $0.015/img)",
      "gpt-image-1-mini:1024x1024:high": "GPT-Image-1 Mini — 1024×1024 High (est. $0.050/img)",
      "gpt-image-1:1024x1024:low":       "GPT-Image-1 — 1024×1024 Low (est. $0.011/img)",
      "gpt-image-1:1024x1024:medium":    "GPT-Image-1 — 1024×1024 Medium (est. $0.040/img)",
      "gpt-image-1:1024x1024:high":      "GPT-Image-1 — 1024×1024 High (est. $0.167/img) ✨",
    },
    default: "dall-e-2:256x256",
  });

  game.settings.register(MODULE_ID, "itemFolder", {
    name: "Item Folder / Pasta de Itens",
    hint: "Folder name in the Items tab where generated items will be placed. / Nome da pasta na aba Items onde os itens gerados serão colocados.",
    scope: "world",
    config: true,
    type: String,
    default: "WyvIAGenerated",
  });

  game.settings.register(MODULE_ID, "generateNpcImage", {
    name: "Generate NPC Image",
    hint: "When enabled, Wyv generates an AI portrait for each NPC. / Quando ativado, gera um retrato de IA para cada NPC criado.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "npcImageModel", {
    name: "NPC Image Model / Modelo de Imagem NPC",
    hint: "AI model, resolution and quality for NPC portraits. / Modelo, resolução e qualidade para retratos de NPC.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      "dall-e-2:256x256":                "DALL-E 2 — 256×256 (est. $0.016/img)",
      "dall-e-2:512x512":                "DALL-E 2 — 512×512 (est. $0.018/img) ★ padrão",
      "dall-e-2:1024x1024":              "DALL-E 2 — 1024×1024 (est. $0.020/img)",
      "dall-e-3:1024x1024":              "DALL-E 3 — 1024×1024 standard (est. $0.040/img)",
      "dall-e-3:1024x1024:hd":          "DALL-E 3 — 1024×1024 HD (est. $0.080/img)",
      "gpt-image-1-mini:1024x1024:low":  "GPT-Image-1 Mini — 1024×1024 Low (est. $0.005/img) 🏆",
      "gpt-image-1-mini:1024x1024:medium": "GPT-Image-1 Mini — 1024×1024 Medium (est. $0.015/img)",
      "gpt-image-1-mini:1024x1024:high": "GPT-Image-1 Mini — 1024×1024 High (est. $0.050/img)",
      "gpt-image-1:1024x1024:low":       "GPT-Image-1 — 1024×1024 Low (est. $0.011/img)",
      "gpt-image-1:1024x1024:medium":    "GPT-Image-1 — 1024×1024 Medium (est. $0.040/img)",
      "gpt-image-1:1024x1024:high":      "GPT-Image-1 — 1024×1024 High (est. $0.167/img) ✨",
    },
    default: "dall-e-2:512x512",
  });

  game.settings.register(MODULE_ID, "npcArtStyle", {
    name: "NPC Art Style / Estilo de Arte",
    hint: "Visual style used when generating NPC portraits. / Estilo visual usado na geração de retratos.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      "fantasy":        "Classic Fantasy (D&D)",
      "dnd_oldschool":  "D&D Old School (pen & ink)",
      "dark_fantasy":   "Dark Fantasy (grimdark)",
      "gothic":         "Gothic Horror",
      "warhammer":      "Warhammer Fantasy",
      "renaissance":    "Renaissance Oil Painting",
      "anime":          "Anime / JRPG",
      "watercolor":     "Watercolor Illustration",
      "noir":           "Noir / Film Noir",
      "painterly":      "Epic Painterly (Artstation)",
      "cyberpunk":      "Cyberpunk / Neon Noir",
      "steampunk":      "Steampunk Victorian",
      "modern":         "Modern Realistic",
      "space":          "Space / Sci-Fi Futuristic",
      "lovecraftian":   "Lovecraftian Horror",
      "celtic":         "Celtic / Norse Mythology",
      "eastern":        "Eastern Fantasy (Wuxia / Samurai)",
      "cartoon":        "Cartoon / Comic Book",
      "pixel":          "Pixel Art / Retro RPG",
    },
    default: "fantasy",
  });

  game.settings.register(MODULE_ID, "npcImageDir", {
    name: "NPC Image Directory",
    hint: "Foundry directory where generated NPC images will be saved. / Diretório onde as imagens dos NPCs serão salvas.",
    scope: "world",
    config: true,
    type: String,
    default: "WyvIA/",
  });

  game.settings.register(MODULE_ID, "npcTokenType", {
    name: "Generate Token / Gerar Token",
    hint: "Type of token to generate for NPCs. Top-Down uses the same model as Debris. / Tipo de token a gerar para NPCs. Top-Down usa o mesmo modelo do Debris.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      "none":     "Nenhum / None",
      "circular": "Circular Token (portrait recortado em círculo, sem custo extra)",
      "topdown":  "Top-Down Character (visão de cima, fundo transparente — usa modelo Debris)",
    },
    default: "none",
  });

  game.settings.register(MODULE_ID, "npcTokenDir", {
    name: "Token Directory / Diretório de Tokens",
    hint: "Foundry directory where NPC token images will be saved.",
    scope: "world",
    config: true,
    type: String,
    default: "WyvIA/Token",
  });

  game.settings.register(MODULE_ID, "npcTokenBorderColor", {
    name: "Circular Token Border Color / Cor da Borda do Token",
    hint: "Border color for circular tokens (hex). / Cor da borda para tokens circulares (hex).",
    scope: "world",
    config: true,
    type: String,
    default: "#7b5ea7",
  });

  game.settings.register(MODULE_ID, "npcTokenBorderWidth", {
    name: "Circular Token Border Width (px) / Largura da Borda (px)",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 4, max: 40, step: 2 },
    default: 16,
  });

  game.settings.register(MODULE_ID, "debrisImageDir", {
    name: "Debris/Props Image Directory",
    hint: "Foundry directory where top-down tile images will be saved. / Diretório onde as imagens top-down serão salvas.",
    scope: "world",
    config: true,
    type: String,
    default: "WyvIA/Debris",
  });

  game.settings.register(MODULE_ID, "debrisImageModel", {
    name: "Debris Image Model / Modelo de Imagem Debris",
    hint: "Model for top-down transparent tile generation (gpt-image only). / Modelo para geração de tiles top-down transparentes.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      "gpt-image-1-mini:1024x1024:low":    "GPT-Image-1 Mini — Low (est. $0.005) ★ padrão",
      "gpt-image-1-mini:1024x1024:medium": "GPT-Image-1 Mini — Medium (est. $0.015)",
      "gpt-image-1-mini:1024x1024:high":   "GPT-Image-1 Mini — High (est. $0.050)",
      "gpt-image-1:1024x1024:low":         "GPT-Image-1 — Low (est. $0.011)",
      "gpt-image-1:1024x1024:medium":      "GPT-Image-1 — Medium (est. $0.040)",
      "gpt-image-1:1024x1024:high":        "GPT-Image-1 — High (est. $0.167) ✨",
    },
    default: "gpt-image-1-mini:1024x1024:low",
  });

  game.settings.register(MODULE_ID, "debrisTileSize", {
    name: "Debris Tile Size (px) / Tamanho do Tile (px)",
    hint: "Size in pixels of the tile placed on the scene. / Tamanho em pixels do tile colocado na cena.",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 64, max: 1024, step: 64 },
    default: 256,
  });

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

  const body = message.slice(trigger.length).trim();

  if (!body) {
    ui.notifications.warn(t("notify.typeQuestion"));
    return false;
  }

  // Verifica permissão do jogador (GM sempre pode)
  if (!game.user.isGM) {
    const permissions = JSON.parse(game.settings.get(MODULE_ID, "playerPermissions") || "{}");
    const allowed = permissions[game.user.id] !== false; // padrão = permitido
    if (!allowed) {
      ui.notifications.warn("Wyv | You don't have permission to use @wyv.");
      return false;
    }
  }

  // Detecta comando /debris
  if (body.toLowerCase().startsWith("/debris")) {
    const description = body.slice(7).trim() || "objeto aleatório";

    if (!game.user.isGM) {
      ui.notifications.warn("Wyv | Apenas o GM pode criar debris/props.");
      return false;
    }

    if (!canvas.scene) {
      ui.notifications.warn("Wyv | Nenhuma cena ativa para colocar o tile.");
      return false;
    }

    _handleDebrisRequest(description);
    return false;
  }

  // Detecta comando /item
  if (body.toLowerCase().startsWith("/item")) {
    let itemBody    = body.slice(5).trim() || "item aleatório";
    let forceImage  = false;

    if (itemBody.toLowerCase().endsWith("--img")) {
      forceImage = true;
      itemBody   = itemBody.slice(0, -5).trim();
    }

    if (!game.user.isGM) {
      ui.notifications.warn("Wyv | Apenas o GM pode criar itens.");
      return false;
    }

    _handleItemRequest(itemBody, forceImage);
    return false;
  }

  // Detecta comando /npc
  if (body.toLowerCase().startsWith("/npc")) {
    let npcBody      = body.slice(4).trim() || "aleatório";
    let forceImage   = false;

    // Detecta flag --img no final da descrição
    if (npcBody.toLowerCase().endsWith("--img")) {
      forceImage = true;
      npcBody    = npcBody.slice(0, -5).trim();
    }

    if (!game.user.isGM) {
      ui.notifications.warn("Wyv | Apenas o GM pode criar NPCs.");
      return false;
    }

    _handleNpcRequest(npcBody, forceImage);
    return false;
  }

  _handleWyvRequest(body);
  return false;
});

// ─── Criação de Debris / Props Top-down ──────────────────────────────────────

async function _handleDebrisRequest(description) {
  const apiUrl       = game.settings.get(MODULE_ID, "apiUrl").replace(/\/$/, "");
  const apiKey       = game.settings.get(MODULE_ID, "apiKey");
  const language     = game.settings.get(MODULE_ID, "language");
  const debrisDir    = game.settings.get(MODULE_ID, "debrisImageDir").replace(/\/$/, "") + "/";
  const debrisModel  = game.settings.get(MODULE_ID, "debrisImageModel");
  const tileSize     = game.settings.get(MODULE_ID, "debrisTileSize");
  const artStyle     = game.settings.get(MODULE_ID, "npcArtStyle");

  const waitingMsg = await _postChatMessage(
    `<em>🐉 Wyv está gerando o prop top-down... <small>(pode levar alguns segundos)</small></em>`,
    true
  );

  try {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["X-API-Key"] = apiKey;

    const response = await fetch(`${apiUrl}/debris`, {
      method:  "POST",
      headers: headers,
      body:    JSON.stringify({
        description,
        language,
        userName:   game.user.name,
        worldName:  game.world.title,
        artStyle:   artStyle,
        imageModel: debrisModel,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${response.status}`);
    }

    const data = await response.json();

    // Upload da imagem pro Foundry
    await FilePicker.createDirectory("data", debrisDir.replace(/\/$/, "")).catch(e => {});

    const safeName = description
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 40);
    const fileName = `${safeName}-${Date.now()}.png`;

    // Converte base64 para Blob
    const [, b64] = data.imageUrl.split(",");
    const binary  = atob(b64);
    const bytes   = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: "image/png" });
    const file = new File([blob], fileName, { type: "image/png" });

    const uploaded = await FilePicker.upload("data", debrisDir.replace(/\/$/, ""), file, {});
    const imagePath = uploaded.path;

    // Posição central da viewport atual
    const pivot  = canvas.stage.pivot;
    const tileX  = pivot.x - tileSize / 2;
    const tileY  = pivot.y - tileSize / 2;

    // Coloca o tile na cena como objeto hidden
    await canvas.scene.createEmbeddedDocuments("Tile", [{
      texture: { src: imagePath },
      x:       tileX,
      y:       tileY,
      width:   tileSize,
      height:  tileSize,
      hidden:  true,
      locked:  false,
      overhead: false,
      alpha:   1,
    }]);

    await waitingMsg?.delete();
    await _postChatMessage(`
      <div class="wyv-response">
        <div class="wyv-header">🐉 (IA) Wyv — Prop Criado</div>
        <div class="wyv-answer">
          <img src="${imagePath}" style="float:right;width:80px;height:80px;object-fit:contain;margin-left:8px;background:repeating-conic-gradient(#ccc 0% 25%,#fff 0% 50%) 0 0/10px 10px;">
          ✅ <strong>${data.name}</strong> adicionado à cena como tile invisível.<br>
          <small>📁 Salvo em: ${imagePath}</small><br>
          <small>💡 Ative na aba Tiles para torná-lo visível.</small>
        </div>
      </div>
    `);

  } catch(error) {
    console.error(`${MODULE_ID} | Debris error:`, error);
    await waitingMsg?.delete();
    const errMsg = typeof error === "string" ? error
      : error?.message || error?.detail || JSON.stringify(error) || "Unknown error";
    await _postChatMessage(
      `<span class="wyv-error">⚠️ Wyv não conseguiu criar o prop: ${errMsg}</span>`
    );
  }
}

// ─── Criação de Item ─────────────────────────────────────────────────────────

/**
 * Lista ícones disponíveis nas pastas relevantes do Foundry.
 * Retorna array de paths para o LLM escolher o mais adequado.
 */
async function _listAvailableIcons(itemType) {
  const ICON_FOLDERS = {
    "weapon":     ["icons/weapons/swords", "icons/weapons/axes", "icons/weapons/blades",
                   "icons/weapons/bows", "icons/weapons/hammers", "icons/weapons/polearms",
                   "icons/weapons/daggers", "icons/weapons/staves"],
    "equipment":  ["icons/equipment/chest", "icons/equipment/head", "icons/equipment/shield",
                   "icons/equipment/hand", "icons/equipment/back", "icons/equipment/feet"],
    "consumable": ["icons/consumables/potions", "icons/consumables/food",
                   "icons/consumables/scrolls"],
    "tool":       ["icons/tools/hand", "icons/tools/cooking", "icons/tools/smithing"],
    "loot":       ["icons/commodities/treasure", "icons/commodities/gems",
                   "icons/commodities/currency"],
    "container":  ["icons/containers/bags", "icons/containers/chest"],
  };

  const folders = ICON_FOLDERS[itemType] || ["icons/svg"];
  const icons   = [];

  for (const folder of folders) {
    try {
      const result = await FilePicker.browse("public", folder);
      if (result?.files?.length) {
        icons.push(...result.files);
      }
    } catch(e) {
      // pasta não existe, ignora
    }
    if (icons.length >= 80) break;  // limite pra não estourar tokens
  }

  return icons.length ? icons : null;
}

/**
 * Seleciona as pastas de ícones mais relevantes com base em palavras-chave da descrição.
 * Retorna até 3 pastas. Fallback: icons/svg
 */
function _selectIconFolders(description) {
  const desc = description.toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, ""); // remove acentos

  const KEYWORD_FOLDERS = [
    // Armas corpo-a-corpo
    { keys: ["sword","espada","longsword","shortsword","greatsword","rapier","scimitar","sabre"],
      folders: ["icons/weapons/swords","icons/weapons/blades"] },
    { keys: ["axe","machado","battleaxe","greataxe","handaxe","hatchet"],
      folders: ["icons/weapons/axes"] },
    { keys: ["dagger","faca","knife","stiletto","dirk","punhal"],
      folders: ["icons/weapons/daggers"] },
    { keys: ["hammer","martelo","warhammer","maul","mace","flail","maca","mangual"],
      folders: ["icons/weapons/hammers"] },
    { keys: ["spear","lanca","polearm","glaive","halberd","pike","trident","lance"],
      folders: ["icons/weapons/polearms","icons/weapons/spears"] },
    { keys: ["staff","cajado","quarterstaff","rod","wand","varinha"],
      folders: ["icons/weapons/staves","icons/weapons/wands"] },
    { keys: ["bow","arco","longbow","shortbow","crossbow","besta"],
      folders: ["icons/weapons/bows"] },
    { keys: ["club","porrete","greatclub","sickle","foice","whip","chicote"],
      folders: ["icons/weapons/clubs"] },
    // Armaduras e equipamentos
    { keys: ["armor","armadura","breastplate","chainmail","leather","scale","plate"],
      folders: ["icons/equipment/chest"] },
    { keys: ["shield","escudo","buckler","targe"],
      folders: ["icons/equipment/shield"] },
    { keys: ["helmet","capacete","helm","hood","hat","chapeu"],
      folders: ["icons/equipment/head"] },
    { keys: ["glove","luva","gauntlet","bracer"],
      folders: ["icons/equipment/hand"] },
    { keys: ["boot","bota","shoe","sapato","feet","sandal"],
      folders: ["icons/equipment/feet"] },
    { keys: ["cloak","capa","cape","mantle","robe","robe","manto"],
      folders: ["icons/equipment/back"] },
    { keys: ["ring","anel","amulet","amuleto","necklace","colar","pendant","talisman"],
      folders: ["icons/equipment/neck","icons/equipment/finger"] },
    { keys: ["belt","cinto","girdle"],
      folders: ["icons/equipment/waist"] },
    // Consumíveis
    { keys: ["potion","pocao","elixir","vial","frasco","brew","tonic"],
      folders: ["icons/consumables/potions"] },
    { keys: ["scroll","pergaminho","tome","livro","spellbook","grimoire"],
      folders: ["icons/consumables/scrolls","icons/sundries/books"] },
    { keys: ["food","comida","ration","racao","meal","feast","bread","pao","fruit","fruta"],
      folders: ["icons/consumables/food"] },
    { keys: ["poison","veneno","venom","toxin"],
      folders: ["icons/consumables/potions"] },
    { keys: ["torch","tocha","candle","vela","lantern","lanterna","lamp"],
      folders: ["icons/sundries/lights"] },
    // Ferramentas
    { keys: ["tool","ferramenta","kit","thieves","lockpick","pick","pry"],
      folders: ["icons/tools/hand"] },
    { keys: ["instrument","instrumento","lute","alaude","flute","flauta","drum","tambor","harp","harpa"],
      folders: ["icons/tools/music"] },
    { keys: ["alchemist","alquimista","herbalist","ervas","herb","mortar","pestle"],
      folders: ["icons/tools/cooking"] },
    { keys: ["smith","ferreiro","forge","forja","anvil","bigorna"],
      folders: ["icons/tools/smithing"] },
    // Tesouros e loot
    { keys: ["gem","gema","jewel","joia","ruby","rubi","emerald","esmeralda","diamond","diamante","sapphire","safira"],
      folders: ["icons/commodities/gems"] },
    { keys: ["gold","ouro","silver","prata","coin","moeda","treasure","tesouro","wealth"],
      folders: ["icons/commodities/currency","icons/commodities/treasure"] },
    { keys: ["bone","osso","skull","caveira","horn","chifre","fang","presa","claw","garra","hide","pele"],
      folders: ["icons/commodities/bones","icons/commodities/biological"] },
    { keys: ["ore","mineral","iron","ferro","ingot","barra","metal","stone","pedra","crystal","cristal"],
      folders: ["icons/commodities/minerals","icons/commodities/stone"] },
    { keys: ["wood","madeira","log","lumber","bark","casca"],
      folders: ["icons/commodities/wood"] },
    { keys: ["cloth","tecido","silk","seda","linen","linho","thread","fio","leather","couro"],
      folders: ["icons/commodities/cloth"] },
    // Containers
    { keys: ["bag","bolsa","backpack","mochila","sack","saco","pouch","bolsinho"],
      folders: ["icons/containers/bags"] },
    { keys: ["chest","bau","crate","caixa","box","coffer","cofre","barrel","barril"],
      folders: ["icons/containers/chest"] },
    // Magia
    { keys: ["magic","magico","magical","arcane","arcana","rune","runa","enchant","encantado","spell","feitico","curse","maldicao"],
      folders: ["icons/magic/symbols","icons/magic/runes"] },
    { keys: ["fire","fogo","flame","chama","burn"],
      folders: ["icons/magic/fire"] },
    { keys: ["ice","gelo","cold","frio","frost","geada"],
      folders: ["icons/magic/water","icons/magic/frost"] },
    { keys: ["lightning","relampago","thunder","trovao","electric","eletrico"],
      folders: ["icons/magic/lightning"] },
    { keys: ["holy","sagrado","divine","divino","celestial","radiant","bless","bencao"],
      folders: ["icons/magic/holy"] },
    { keys: ["dark","sombra","shadow","necro","undead","morto","death","morte","curse","maldicao"],
      folders: ["icons/magic/unholy","icons/magic/darkness"] },
    { keys: ["nature","natureza","plant","planta","leaf","folha","growth","vine","trepadeira"],
      folders: ["icons/magic/nature"] },
    // Outros
    { keys: ["dice","dado","game","jogo"],
      folders: ["icons/dice"] },
    { keys: ["key","chave","lock","fechadura"],
      folders: ["icons/sundries/keys"] },
    { keys: ["book","livro","tome","manual","journal","diario"],
      folders: ["icons/sundries/books"] },
    { keys: ["rope","corda","chain","corrente","net","rede"],
      folders: ["icons/sundries/rope"] },
  ];

  const matched = new Set();
  for (const { keys, folders } of KEYWORD_FOLDERS) {
    if (keys.some((kw) => desc.includes(kw))) {
      folders.forEach((f) => matched.add(f));
      if (matched.size >= 4) break;
    }
  }

  // Fallback se não achou nada
  if (!matched.size) matched.add("icons/svg");

  return [...matched].slice(0, 4);
}

async function _handleItemRequest(description, forceImage = false) {
  const apiUrl          = game.settings.get(MODULE_ID, "apiUrl").replace(/\/$/, "");
  const apiKey          = game.settings.get(MODULE_ID, "apiKey");
  const language        = game.settings.get(MODULE_ID, "language");
  const generateImage   = game.settings.get(MODULE_ID, "generateItemImage");
  const npcArtStyle     = game.settings.get(MODULE_ID, "npcArtStyle");
  const npcImageDir     = game.settings.get(MODULE_ID, "npcImageDir").replace(/\/$/, "") + "/";
  const itemImageModel  = game.settings.get(MODULE_ID, "itemImageModel");

  const itemImageNote = (generateImage || forceImage)
    ? " <small>(gerando imagem, pode levar alguns segundos a mais)</small>"
    : "";
  const waitingMsg = await _postChatMessage(
    `<em>🐉 Wyv está criando o item...${itemImageNote}</em>`,
    true
  );

  try {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["X-API-Key"] = apiKey;

    // Seleciona pastas de ícones por palavras-chave da descrição
    const selectedFolders = _selectIconFolders(description);

    // Lista os arquivos das pastas selecionadas
    const allIcons = [];
    for (const folder of selectedFolders) {
      try {
        const r = await FilePicker.browse("public", folder);
        if (r?.files?.length) allIcons.push(...r.files);
      } catch(e) {}
      if (allIcons.length >= 100) break;
    }

    const response = await fetch(`${apiUrl}/item`, {
      method:  "POST",
      headers: headers,
      body:    JSON.stringify({
        description,
        language,
        userName:       game.user.name,
        worldName:      game.world.title,
        systemId:       game.system.id,
        generateImage:  generateImage || forceImage,
        artStyle:       npcArtStyle,
        imageModel:     itemImageModel,
        availableIcons: allIcons.slice(0, 120),
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${response.status}`);
    }

    const data = await response.json();

    // Upload da imagem se gerada — usa como img do item
    if (data.imageUrl) {
      const imagePath = await _uploadNpcImage(data.imageUrl, data.name, npcImageDir);
      if (imagePath) data.item.img = imagePath;
    }

    // Busca ou cria pasta na aba Items
    const folderName = game.settings.get(MODULE_ID, "itemFolder").trim();
    const folderId   = folderName ? await _getOrCreateItemFolder(folderName) : null;
    if (folderId) data.item.folder = folderId;

    // Cria o item na aba Items do Foundry
    await Item.create(data.item);

    await waitingMsg?.delete();
    await _postChatMessage(`
      <div class="wyv-response">
        <div class="wyv-header">🐉 (IA) Wyv — Item Criado</div>
        <div class="wyv-answer">
          ${_markdownToHtml(data.summary)}<br><br>
          <em>✅ <strong>${data.name}</strong> foi adicionado à aba Items${folderName ? `, na pasta <strong>${folderName}</strong>` : ""}.</em>
        </div>
      </div>
    `);

  } catch (error) {
    console.error(`${MODULE_ID} | Item error:`, error);
    await waitingMsg?.delete();
    const errMsg = typeof error === "string" ? error
      : error?.message || error?.detail || JSON.stringify(error) || "Unknown error";
    await _postChatMessage(
      `<span class="wyv-error">⚠️ Wyv não conseguiu criar o item: ${errMsg}</span>`
    );
  }
}

async function _getOrCreateItemFolder(folderName) {
  if (!folderName) return null;

  const existing = game.folders.find(
    (f) => f.type === "Item" && f.name === folderName
  );
  if (existing) return existing.id;

  try {
    const folder = await Folder.create({
      name:  folderName,
      type:  "Item",
      color: "#7b5ea7",
    });
    console.log(`${MODULE_ID} | Item folder created: ${folderName}`);
    return folder.id;
  } catch (err) {
    console.warn(`${MODULE_ID} | Failed to create item folder:`, err);
    return null;
  }
}

// ─── Criação de NPC ──────────────────────────────────────────────────────────

async function _handleNpcRequest(description, forceImage = false) {
  const apiUrl       = game.settings.get(MODULE_ID, "apiUrl").replace(/\/$/, "");
  const apiKey       = game.settings.get(MODULE_ID, "apiKey");
  const language     = game.settings.get(MODULE_ID, "language");
  const generateImage  = game.settings.get(MODULE_ID, "generateNpcImage");
  const npcImageDir    = game.settings.get(MODULE_ID, "npcImageDir").replace(/\/$/, "") + "/";
  const npcArtStyle    = game.settings.get(MODULE_ID, "npcArtStyle");
  const npcImageModel  = game.settings.get(MODULE_ID, "npcImageModel");

  const imageNote = (generateImage || forceImage)
    ? " <small>(gerando imagem, pode levar alguns segundos a mais)</small>"
    : "";
  const waitingMsg = await _postChatMessage(
    `<em>🐉 Wyv está criando o NPC...${imageNote}</em>`,
    true
  );

  try {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["X-API-Key"] = apiKey;

    // Busca NPC anterior só se a descrição referenciar
    const previousNpc = _getLastNpcContext(description);

    const response = await fetch(`${apiUrl}/npc`, {
      method:  "POST",
      headers: headers,
      body:    JSON.stringify({
        description,
        language,
        userName:      game.user.name,
        worldName:     game.world.title,
        generateImage: generateImage || forceImage,
        artStyle:      npcArtStyle,
        imageModel:    npcImageModel,
        previousNpc:   previousNpc,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${response.status}`);
    }

    const data = await response.json();

    // Faz upload da imagem se gerada
    let imagePath = null;
    if (data.imageUrl) {
      imagePath = await _uploadNpcImage(data.imageUrl, data.name, npcImageDir);
    }

    // Injeta imagem no actor data se disponível
    const actorData = data.actor;
    if (imagePath) {
      actorData.img = imagePath;
      actorData.prototypeToken = actorData.prototypeToken || {};
      actorData.prototypeToken.texture = { src: imagePath };
    }

    // Busca ou cria a pasta configurada na aba Actors
    const folderName = game.settings.get(MODULE_ID, "npcActorFolder").trim();
    const folderId   = folderName ? await _getOrCreateActorFolder(folderName) : null;
    if (folderId) actorData.folder = folderId;

    // Cria o ator na aba Actors do Foundry
    await Actor.create(actorData);

    await waitingMsg?.delete();

    // Salva o NPC nos flags para referência futura ("igual ao anterior", etc.)
    await _postChatMessage(`
      <div class="wyv-response">
        <div class="wyv-header">🐉 (IA) Wyv — NPC Criado</div>
        <div class="wyv-answer">
          ${imagePath ? `<img src="${imagePath}" style="float:right;width:80px;height:80px;object-fit:cover;border-radius:4px;margin-left:8px;">` : ""}
          ${_markdownToHtml(data.summary)}<br><br>
          <em>✅ <strong>${data.name}</strong> foi adicionado à aba Actors${folderName ? `, na pasta <strong>${folderName}</strong>` : ""}.</em>
        </div>
      </div>
    `, false, { npcData: JSON.stringify(data.actor) });

  } catch (error) {
    console.error(`${MODULE_ID} | NPC error:`, error);
    await waitingMsg?.delete();
    const errMsg = typeof error === "string" ? error
      : error?.message || error?.detail || JSON.stringify(error) || "Unknown error";
    await _postChatMessage(
      `<span class="wyv-error">⚠️ Wyv não conseguiu criar o NPC: ${errMsg}</span>`
    );
  }
}

// ─── Lógica principal ────────────────────────────────────────────────────────

async function _handleWyvRequest(userMessage) {
  const apiUrl      = game.settings.get(MODULE_ID, "apiUrl").replace(/\/$/, "");
  const apiKey      = game.settings.get(MODULE_ID, "apiKey");
  const language    = game.settings.get(MODULE_ID, "language");
  const historySize = game.settings.get(MODULE_ID, "historySize");
  const isGM        = game.user.isGM;
  const conciseMode  = game.settings.get(MODULE_ID, "conciseMode");
  const dndEdition   = game.settings.get(MODULE_ID, "dndEdition");
  const useSrdApi    = game.settings.get(MODULE_ID, "useSrdApi");

  // Busca regras nos compêndios configurados antes de montar o payload
  const rulesContext = await _searchCompendiumRules(userMessage);

  const payload = {
    message:      userMessage,
    language:     language,
    userName:     game.user.name,
    worldName:    game.world.title,
    systemId:     game.system.id,
    isGM:         isGM,
    conciseMode:  conciseMode,
    dndEdition:   dndEdition,
    useSrdApi:    useSrdApi,
    actorContext: _getActorContext(),
    history:      _buildHistory(historySize),
    rulesContext: rulesContext,
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

// ─── Busca de Regras no Compêndio ────────────────────────────────────────────

/**
 * Busca entradas relevantes nos compêndios configurados.
 * Estratégia: busca por palavras-chave da mensagem no índice do pack,
 * carrega as entradas que baterem e extrai o texto das páginas.
 *
 * @param {string} message - Mensagem do jogador
 * @returns {Array<{source: string, text: string}>|null}
 */
async function _searchCompendiumRules(message) {
  const packsConfig = game.settings.get(MODULE_ID, "compendiumPacks").trim();
  if (!packsConfig) return null;

  const packIds  = packsConfig.split(",").map((s) => s.trim()).filter(Boolean);
  const keywords = _extractKeywords(message);
  if (!keywords.length) return null;

  const results = [];

  for (const packId of packIds) {
    const pack = game.packs.get(packId);
    if (!pack) {
      console.warn(`${MODULE_ID} | Pack not found: ${packId}`);
      continue;
    }

    // Filtra o índice pelo nome das entradas
    const matchingIndex = pack.index.filter((entry) => {
      const entryName = (entry.name || "").toLowerCase();
      return keywords.some((kw) => entryName.includes(kw));
    });

    for (const indexEntry of matchingIndex.slice(0, 3)) {
      try {
        const doc = await pack.getDocument(indexEntry._id);
        if (!doc) continue;

        // JournalEntry tem pages com conteúdo
        const pages = doc.pages?.contents ?? [];
        const text  = pages
          .map((p) => p.text?.content ?? p.text?.markdown ?? "")
          .join(" ")
          .replace(/<[^>]*>/g, " ")   // remove HTML tags
          .replace(/\s+/g, " ")        // normaliza espaços
          .trim()
          .slice(0, 1200);             // limita o tamanho

        if (text) {
          results.push({ source: `${packId} → ${doc.name}`, text });
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Error loading doc ${indexEntry._id}:`, err);
      }
    }
  }

  return results.length ? results : null;
}

/**
 * Dicionário de tradução pt-BR → en para termos comuns de RPG.
 * Garante que as keywords batam com o conteúdo do SRD (sempre em inglês).
 */
const RPG_TRANSLATIONS = {
  // Atributos
  "força": "strength", "forca": "strength",
  "destreza": "dexterity",
  "constituição": "constitution", "constituicao": "constitution",
  "inteligência": "intelligence", "inteligencia": "intelligence",
  "sabedoria": "wisdom",
  "carisma": "charisma",
  // Combate
  "ataque": "attack", "ataques": "attack",
  "dano": "damage",
  "armadura": "armor",
  "iniciativa": "initiative",
  "movimento": "movement", "movimentação": "movement",
  "estabilizar": "stabilizing", "estabilização": "stabilizing",
  "morte": "death", "salvaguarda": "saving throw",
  "inconsciente": "unconscious",
  "curar": "healing", "cura": "healing",
  "descanso": "rest", "descanso curto": "short rest", "descanso longo": "long rest",
  // Ações
  "ação": "action", "ações": "action",
  "reação": "reaction",
  "bônus": "bonus",
  "habilidade": "ability", "habilidades": "ability",
  "magia": "spell", "magias": "spell",
  "feitiço": "spell", "feitiços": "spell",
  "concentração": "concentration",
  "ritual": "ritual",
  "espaço": "slot", "espaços": "slot",
  // Classes e personagem
  "classe": "class",
  "nível": "level", "nivel": "level",
  "raça": "race", "espécie": "species",
  "antecedente": "background",
  "perícia": "skill", "perícias": "skill", "pericia": "skill",
  "proficiência": "proficiency", "proficiencia": "proficiency",
  "vantagem": "advantage",
  "desvantagem": "disadvantage",
  "inspiração": "inspiration", "inspiracao": "inspiration",
  // Condições
  "amedrontado": "frightened",
  "agarrado": "grappled",
  "incapacitado": "incapacitated",
  "invisível": "invisible", "invisivel": "invisible",
  "paralisado": "paralyzed",
  "petrificado": "petrified",
  "envenenado": "poisoned",
  "prostrado": "prone",
  "contido": "restrained",
  "atordoado": "stunned",
  "inconsciente": "unconscious",
  // Equipamento
  "arma": "weapon", "armas": "weapon",
  "escudo": "shield",
  "item": "item", "itens": "item",
  "equipamento": "equipment",
  "kit": "kit",
  // Misc
  "teste": "check", "testes": "check",
  "resistência": "resistance", "resistencia": "resistance",
  "imunidade": "immunity",
  "vulnerabilidade": "vulnerability",
  "crítico": "critical", "critico": "critical",
  "furtividade": "stealth",
  "percepção": "perception", "percepcao": "perception",
};

/**
 * Extrai palavras-chave relevantes da mensagem e traduz termos pt-BR → en.
 * Remove stopwords comuns em pt-BR e en.
 */
function _extractKeywords(message) {
  const stopwords = new Set([
    // pt-BR
    "o","a","os","as","um","uma","de","do","da","dos","das","em","no","na",
    "nos","nas","e","ou","que","se","para","por","com","como","qual","quais",
    "tem","pode","meu","minha","seu","sua","são","foi","ter","fazer",
    "isso","esse","essa","isto","aqui","quando","onde","mais","este","esta",
    // en
    "the","an","of","in","on","at","to","for","is","are","was","were",
    "can","how","what","when","where","his","her","their","you","we",
  ]);

  const words = message
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")  // remove acentos para matching
    .replace(/[^a-z\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopwords.has(w));

  // Expande com traduções: mantém a palavra original E adiciona a tradução em inglês
  const expanded = new Set();
  for (const word of words) {
    expanded.add(word);
    // Tenta traduzir a versão com acento também
    const original = message.toLowerCase().split(/\s+/).find(
      (w) => w.normalize("NFD").replace(/[̀-ͯ]/g, "") === word
    ) || word;
    const translation = RPG_TRANSLATIONS[original] || RPG_TRANSLATIONS[word];
    if (translation) expanded.add(translation);
  }

  return [...expanded];
}

// ─── Pasta de Atores ─────────────────────────────────────────────────────────

/**
 * Busca ou cria uma pasta na aba Actors com o nome configurado.
 * Retorna o ID da pasta.
 */
async function _getOrCreateActorFolder(folderName) {
  if (!folderName) return null;

  // Busca pasta existente pelo nome
  const existing = game.folders.find(
    (f) => f.type === "Actor" && f.name === folderName
  );
  if (existing) return existing.id;

  // Cria nova pasta
  try {
    const folder = await Folder.create({
      name:  folderName,
      type:  "Actor",
      color: "#7b5ea7",
    });
    console.log(`${MODULE_ID} | Actor folder created: ${folderName}`);
    return folder.id;
  } catch (err) {
    console.warn(`${MODULE_ID} | Failed to create actor folder:`, err);
    return null;
  }
}

// ─── Upload de Imagem do NPC ─────────────────────────────────────────────────

/**
 * Baixa a imagem da URL temporária (DALL-E expira em ~1h) e
 * faz upload pro servidor do Foundry via FilePicker.upload().
 * Retorna o path final da imagem ou null em caso de erro.
 */
async function _uploadNpcImage(imageUrl, npcName, uploadDir) {
  try {
    // Cria o diretório se não existir
    await FilePicker.createDirectory("data", uploadDir.replace(/\/$/, "")).catch(() => {});

    // Converte base64 data URI para Blob (evita CORS — backend já baixou a imagem)
    let blob;
    if (imageUrl.startsWith("data:")) {
      const [, b64] = imageUrl.split(",");
      const binary  = atob(b64);
      const bytes   = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      blob = new Blob([bytes], { type: "image/png" });
    } else {
      const response = await fetch(imageUrl);
      if (!response.ok) throw new Error(`Image fetch failed: ${response.status}`);
      blob = await response.blob();
    }

    // Nome de arquivo seguro baseado no nome do NPC
    const safeName = npcName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 40);
    const fileName  = `${safeName}-${Date.now()}.png`;
    const file      = new File([blob], fileName, { type: "image/png" });

    // Upload pro Foundry
    const result = await FilePicker.upload("data", uploadDir.replace(/\/$/, ""), file, {});
    console.log(`${MODULE_ID} | Image uploaded: ${result.path}`);
    return result.path;

  } catch (err) {
    console.warn(`${MODULE_ID} | Image upload failed:`, err);
    return null;
  }
}

// ─── Contexto de NPC Anterior ────────────────────────────────────────────────

/**
 * Palavras-chave que indicam que o usuário quer referenciar um NPC anterior.
 */
const NPC_REFERENCE_KEYWORDS = [
  // pt-BR
  "anterior", "mesmo", "igual", "parecido", "similar", "aquele", "esse personagem",
  "o anterior", "o último", "ultima", "último", "como ele", "como ela",
  "baseado", "baseado nele", "baseado nela", "variação", "versão", "derivado",
  "mesma ideia", "conceito parecido", "inspirado", "tipo aquele", "tipo aquela",
  // en
  "previous", "same", "similar", "last", "that character", "like him", "like her",
  "based on", "variation of", "version of", "inspired by", "like the last",
  "like the previous", "like before", "the one before", "aforementioned",
  "that npc", "that one", "like that", "alike", "resembling",
];

/**
 * Verifica se a descrição referencia um NPC anterior e retorna os dados dele.
 * Só busca se a descrição contiver palavras-chave de referência.
 */
function _getLastNpcContext(description) {
  const lower = description.toLowerCase();
  const hasReference = NPC_REFERENCE_KEYWORDS.some((kw) => lower.includes(kw));
  if (!hasReference) return null;

  // Busca a última mensagem do Wyv que tenha npcData nos flags
  const npcMessages = game.messages.contents.filter(
    (msg) => msg.flags?.[MODULE_ID]?.npcData
  );

  if (!npcMessages.length) return null;

  const lastNpcMsg = npcMessages[npcMessages.length - 1];
  try {
    return JSON.parse(lastNpcMsg.flags[MODULE_ID].npcData);
  } catch(e) {
    return null;
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