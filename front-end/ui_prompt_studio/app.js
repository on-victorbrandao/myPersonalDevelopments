// troque pela Gemini key — gerada em aistudio.google.com
const API_KEY = '%%GEMINI_API_KEY%%';

const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

const SYSTEM_PROMPT = `
Você é um especialista sênior em HTML, CSS e JavaScript puro (vanilla).
Retorne APENAS o código — nenhum texto antes, nenhum texto depois.
Não use blocos de markdown. Não escreva \`\`\`html nem \`\`\` em nenhum momento.
Não inclua <meta name="viewport"> em nenhuma hipótese.
A resposta inteira deve começar exatamente com <!DOCTYPE html> e terminar com </html>.
Entregue um único arquivo HTML com <style> e <script> embutidos.

Siga obrigatoriamente:
- Indentação de 2 espaços e variáveis CSS no :root
- O body deve ter: margin: 0; padding: 16px; background: transparent;
- Os elementos devem estar posicionados no topo esquerdo, sem centralização forçada, a menos que o usuário peça explicitamente
- Animações com CSS transforms e opacity; cubic-bezier quando necessário
- Formas geométricas em SVG inline ou Canvas
- Semântica HTML5 e atributos ARIA onde fizer sentido
- Código compatível com Chrome, Firefox e Safari modernos
- Sem bibliotecas externas, CDNs ou imagens de terceiros
- Se o pedido for vago, interprete da forma mais sofisticada visualmente
`.trim();

const GENERATION_CONFIG = {
    temperature: 0.7,
    maxOutputTokens: 65535,
};

const RETRY_CONFIG = {
    maxRetries: 2,
    baseDelayMs: 1200,
    maxDelayMs: 15000,
    minIntervalMs: 1200,
};

const el = {
    prompt: document.getElementById('prompt'),
    btnSend: document.getElementById('btn-send'),
    btnCopy: document.getElementById('btn-copy'),
    btnClear: document.getElementById('btn-clear'),
    btnRefresh: document.getElementById('btn-refresh'),
    codeOutput: document.getElementById('code-output'),
    previewFrame: document.getElementById('preview-frame'),
    codePlaceholder: document.getElementById('code-placeholder'),
    previewPlaceholder: document.getElementById('preview-placeholder'),
    loaderCode: document.getElementById('loader-code'),
    loaderPreview: document.getElementById('loader-preview'),
};

let lastCode = '';
let loading = false;
let lastRequestAt = 0;
let retryCountdownTimer = null;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function extractHTML(raw) {
    const start = raw.indexOf('<!DOCTYPE');
    const end = raw.lastIndexOf('</html>');

    if (start !== -1 && end !== -1) {
        return raw.slice(start, end + '</html>'.length).trim();
    }

    return raw
        .replace(/^```[\w-]*\n?/i, '')
        .replace(/\n?```$/i, '')
        .trim();
}

function isCodeComplete(code) {
    return code.trimEnd().toLowerCase().endsWith('</html>');
}

function getBackoffDelay(attempt) {
    const exponential = Math.min(
        RETRY_CONFIG.baseDelayMs * (2 ** attempt),
        RETRY_CONFIG.maxDelayMs
    );
    return exponential + Math.floor(Math.random() * 500);
}

async function enforceClientSidePacing() {
    const elapsed = Date.now() - lastRequestAt;

    if (elapsed < RETRY_CONFIG.minIntervalMs) {
        await sleep(RETRY_CONFIG.minIntervalMs - elapsed);
    }

    lastRequestAt = Date.now();
}

function extractRetrySeconds(message, payload) {
    const fromPayload = payload?.error?.details
        ?.find(d => d?.retryDelay)
        ?.retryDelay?.replace('s', '');

    if (fromPayload && !Number.isNaN(Number(fromPayload))) {
        return Math.max(1, Math.ceil(Number(fromPayload)));
    }

    const match = (message || '').match(/retry in\s+([\d.]+)s/i);
    if (match) return Math.max(1, Math.ceil(Number(match[1])));

    return null;
}

function isRateLimitError(status, message, payload) {
    if (status === 429) return true;

    const text = `${message || ''} ${payload?.error?.status || ''}`.toLowerCase();
    return (
        text.includes('quota exceeded') ||
        text.includes('rate limit') ||
        text.includes('resource_exhausted') ||
        text.includes('too many requests')
    );
}

function parseFriendlyError(message, retrySeconds) {
    const isRateLimit = /quota exceeded|rate limit|resource_exhausted|429/i.test(message);

    if (isRateLimit) {
        return retrySeconds
            ? `Limite da API atingido. Tente novamente em ${retrySeconds}s.`
            : 'Limite da API atingido. Aguarde alguns instantes e tente novamente.';
    }

    return message;
}

function clearRetryCountdown() {
    if (retryCountdownTimer) {
        clearInterval(retryCountdownTimer);
        retryCountdownTimer = null;
    }
}

function startRetryCountdown(seconds) {
    clearRetryCountdown();

    let remaining = seconds;
    renderBtnSend(remaining);

    retryCountdownTimer = setInterval(() => {
        remaining -= 1;

        if (remaining <= 0) {
            clearRetryCountdown();
            el.btnSend.disabled = false;
            renderBtnSend(null);
            return;
        }

        renderBtnSend(remaining);
    }, 1000);
}

function renderBtnSend(countdown) {
    el.btnSend.innerHTML = '';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '22'); line.setAttribute('y1', '2');
    line.setAttribute('x2', '11'); line.setAttribute('y2', '13');

    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.setAttribute('points', '22 2 15 22 11 13 2 9 22 2');

    svg.appendChild(line);
    svg.appendChild(polygon);
    el.btnSend.appendChild(svg);

    if (countdown !== null) {
        const span = document.createElement('span');
        span.className = 'btn-countdown';
        span.textContent = `${countdown}s`;
        el.btnSend.appendChild(span);
    }
}

async function requestGeneration(userPrompt) {
    await enforceClientSidePacing();

    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                parts: [{ text: `${SYSTEM_PROMPT}\n\nSolicitação: ${userPrompt}` }],
            }],
            generationConfig: GENERATION_CONFIG,
        }),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
        const error = new Error(payload?.error?.message || `HTTP ${response.status}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
    }

    const raw = (payload?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
    return extractHTML(raw);
}

async function generate(userPrompt) {
    let lastError = null;

    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
        try {
            return await requestGeneration(userPrompt);
        } catch (error) {
            lastError = error;

            if (!isRateLimitError(error.status, error.message, error.payload)) {
                throw error;
            }

            if (attempt === RETRY_CONFIG.maxRetries) throw error;

            const retrySeconds = extractRetrySeconds(error.message, error.payload);
            const waitMs = retrySeconds ? retrySeconds * 1000 : getBackoffDelay(attempt);

            await sleep(waitMs);
        }
    }

    throw lastError;
}

function showCode(code) {
    el.codePlaceholder.style.display = 'none';
    el.codeOutput.textContent = code;
    el.codeOutput.style.display = 'block';
}

function showPreview(code) {
    if (!code) return;

    el.previewPlaceholder.style.display = 'none';
    el.previewFrame.style.display = 'block';

    const safeCode = code.replace(/<meta[^>]*viewport[^>]*>/gi, '');
    const wrapped = `
    <style>
      html, body {
        zoom: 1 !important;
        transform: none !important;
        -webkit-text-size-adjust: 100% !important;
        min-width: 0 !important;
      }
    </style>
    ${safeCode}
  `;

    el.previewFrame.srcdoc = '';
    requestAnimationFrame(() => {
        el.previewFrame.srcdoc = wrapped;
    });
}

function showError(message, retrySeconds) {
    const friendly = parseFriendlyError(message, retrySeconds);
    el.codePlaceholder.textContent = `Erro: ${friendly}`;
    el.codePlaceholder.classList.add('panel__placeholder--error');
    el.codePlaceholder.style.display = 'inline';
    el.codeOutput.style.display = 'none';
}

function reset() {
    lastCode = '';
    clearRetryCountdown();
    renderBtnSend(null);

    el.codeOutput.textContent = '';
    el.codeOutput.style.display = 'none';

    el.codePlaceholder.textContent = 'Espaço para geração dos códigos...';
    el.codePlaceholder.classList.remove('panel__placeholder--error');
    el.codePlaceholder.style.display = 'inline';

    el.previewFrame.srcdoc = '';
    el.previewFrame.style.display = 'none';
    el.previewPlaceholder.style.display = 'inline';

    el.prompt.value = '';
    el.prompt.style.height = 'auto';
    el.prompt.style.overflowY = 'hidden';
    el.btnSend.disabled = false;
}

function setLoading(active) {
    loading = active;
    el.btnSend.disabled = active;

    el.loaderCode.style.display = active ? 'flex' : 'none';
    el.loaderPreview.style.display = active ? 'flex' : 'none';

    if (active) {
        clearRetryCountdown();
        renderBtnSend(null);
        el.codePlaceholder.classList.remove('panel__placeholder--error');
        el.codePlaceholder.style.display = 'none';
        el.previewPlaceholder.style.display = 'none';
        el.codeOutput.style.display = 'none';
        el.previewFrame.style.display = 'none';
    }
}

async function handleSend() {
    const prompt = el.prompt.value.trim();
    if (!prompt || loading) return;

    setLoading(true);

    try {
        const code = await generate(prompt);

        if (!isCodeComplete(code)) {
            showCode(code);
            showError('Código gerado incompleto. Tente novamente ou simplifique a solicitação.');
            return;
        }

        lastCode = code;
        showCode(code);
        showPreview(code);
    } catch (err) {
        const retrySeconds = extractRetrySeconds(err.message, err.payload);

        if (retrySeconds) {
            el.btnSend.disabled = true;
            startRetryCountdown(retrySeconds);
        }

        showError(err.message, retrySeconds);
    } finally {
        setLoading(false);
    }
}

async function handleCopy() {
    if (!lastCode) return;

    try {
        await navigator.clipboard.writeText(lastCode);
        const old = el.btnCopy.textContent;
        el.btnCopy.textContent = 'Copiado!';
        setTimeout(() => { el.btnCopy.textContent = old; }, 1800);
    } catch {
        showError('Não foi possível copiar.');
    }
}

function resizeTextarea() {
    el.prompt.style.height = 'auto';

    const scrollH = el.prompt.scrollHeight;
    const maxH = 180;

    if (scrollH <= maxH) {
        el.prompt.style.height = `${scrollH}px`;
        el.prompt.style.overflowY = 'hidden';
    } else {
        el.prompt.style.height = `${maxH}px`;
        el.prompt.style.overflowY = 'auto';
    }
}

el.btnSend.addEventListener('click', handleSend);
el.btnCopy.addEventListener('click', handleCopy);
el.btnClear.addEventListener('click', reset);

el.btnRefresh.addEventListener('click', () => {
    if (lastCode) showPreview(lastCode);
});

el.prompt.addEventListener('input', resizeTextarea);

el.prompt.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        handleSend();
    }
});
