const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const { PDFDocument, rgb, degrees } = require('pdf-lib');
const crypto = require('crypto');
const sharp = require('sharp');

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('O cérebro da Inteligência Artificial está online e a funcionar! 🚀');
});

app.use(cors());
app.use(express.json());

// Set up temporary storage for uploaded receipts
const upload = multer({ dest: 'uploads/' });

// In-memory store for rate limiting by IP (simple anti-spam)
const failedAttempts = {};
const blockList = {};

// Database in-memory e em arquivo para comprovativos usados (Anti-Duplicação)
const DB_FILE = path.join(__dirname, 'used_receipts.json');
let usedReceipts = new Set();
if (fs.existsSync(DB_FILE)) {
    try {
        usedReceipts = new Set(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
    } catch(e) {}
}

function getFileHash(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    const hashSum = crypto.createHash('sha256');
    hashSum.update(fileBuffer);
    return hashSum.digest('hex');
}

// Evaluate Logic ported from Frontend
function evaluateReceiptData(text, originalName, fileSize) {
    const cleanText = text.replace(/[\s\.\-\,]+/g, '').toLowerCase();
    const originalText = text.toLowerCase();

    // 1. Verificação do Número ou Nome do Beneficiário
    const numOk = cleanText.includes('931289088') || cleanText.includes('925109868');
    const nameOk = originalText.includes('abel tabela dengue') || originalText.includes('abel dengue');
    const recipientOk = numOk || nameOk;
    const recipientText = recipientOk ? '✓ Beneficiário Confirmado (Abel Dengue)' : '✗ Beneficiário Incorreto ou não detetado';

    // 2. Verificação do Valor (2.490 Kz)
    const amountOk = cleanText.includes('2490') || originalText.includes('2.490') || originalText.includes('2 490');
    const amountText = amountOk ? '✓ Valor Confirmado (2.490 Kz)' : '✗ Valor Incorreto';

    // 3. Verificação Estrita da Data (Deve ser HOJE)
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yyyy = today.getFullYear();
    
    // Possíveis formatos que o banco pode apresentar
    const dateFormats = [
        `${dd}/${mm}/${yyyy}`,
        `${dd}-${mm}-${yyyy}`,
        `${yyyy}-${mm}-${dd}`,
        `${dd}/${mm}/${String(yyyy).slice(-2)}`,
        `${dd}-${mm}-${String(yyyy).slice(-2)}`,
        'hoje', 'today'
    ];
    
    // Se a data formatada sem barras/traços existir no texto limpo, o OCR leu corretamente os números da data
    const dateOk = dateFormats.some(df => cleanText.includes(df.replace(/[\/\-]/g, '')) || originalText.includes(df));
    const dateText = dateOk ? `✓ Data Válida (Pagamento de Hoje: ${dd}/${mm}/${yyyy})` : '✗ Data Inválida (Apenas pagamentos feitos hoje são aceites)';

    // 4. Verificação de Conclusão de Pagamento (Evita capturas de ecrã antes de concluir a transferência)
    const successTerms = ['sucesso', 'concluid', 'concluíd', 'realizada', 'estado:sucesso', 'comprovativo', 'recibo', 'transferencia', 'transferência'];
    const successOk = successTerms.some(term => cleanText.includes(term.replace(/[\s\:]/g, '')) || originalText.includes(term));
    const termsText = successOk ? '✓ Transação Concluída com Sucesso' : '✗ Transação Incompleta (Aguardando conclusão)';

    // Anti-fraude básico (Nomes de arquivos suspeitos)
    const bad = ['fake', 'test', 'sample', 'demo', 'placeholder', 'lorem', 'comprovativo_falso', 'falso'];
    const fileNameLower = originalName.toLowerCase();
    let nameSuspect = bad.some(word => fileNameLower.includes(word));

    // A VALIDAÇÃO ESTABELECIDA PELO UTILIZADOR:
    // DEVE validar estritamente se o destinatário, a data (de hoje), o valor E O SUCESSO DO PAGAMENTO estiverem corretos.
    const isGenuine = !nameSuspect && recipientOk && dateOk && amountOk && successOk;

    return {
        ok: isGenuine,
        reason: nameSuspect ? 'Nome do arquivo suspeito.' : (isGenuine ? 'Aprovado' : 'O comprovativo foi rejeitado porque os dados não conferem (Verifique se é um pagamento CONCLUÍDO para Abel Dengue, feito no dia de HOJE, no valor exato de 2.490 Kz).'),
        details: {
            format: { ok: !nameSuspect, label: 'Anti-Fraude', value: nameSuspect ? 'Arquivo Suspeito' : 'Seguro' },
            recipient: { ok: recipientOk, label: 'Destinatário', value: recipientText },
            amount: { ok: amountOk, label: 'Valor da Transação', value: amountText },
            date: { ok: dateOk, label: 'Data da Operação', value: dateText },
            terms: { ok: successOk, label: 'Status da Transação', value: termsText }
        }
    };
}

function generateToken(name, whatsapp) {
    let h = 0;
    const s = name + whatsapp + Date.now() + 'ABEL-DENGUE-2026';
    for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h = h & h; }
    return 'EBOOK-' + Math.abs(h).toString(36).toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
}

app.post('/api/verify-receipt', upload.single('receipt'), async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;

    // Check rate limit block
    if (blockList[ip] && Date.now() < blockList[ip]) {
        const timeLeft = Math.ceil((blockList[ip] - Date.now()) / 60000);
        return res.status(429).json({
            ok: false,
            reason: `Muitas tentativas suspeitas. Tente novamente em ${timeLeft} minutos.`,
            blocked: true,
            timeLeft
        });
    }

    try {
        const { name, whatsapp } = req.body;
        const file = req.file;

        if (!file || !name || !whatsapp) {
            return res.status(400).json({ ok: false, reason: 'Dados incompletos.' });
        }

        // Anti-Fraud: Duplicate Image Check (Hash Verification)
        const fileHash = getFileHash(file.path);
        if (usedReceipts.has(fileHash)) {
            failedAttempts[ip] = (failedAttempts[ip] || 0) + 1;
            if (failedAttempts[ip] >= 3) {
                blockList[ip] = Date.now() + 3600000;
                delete failedAttempts[ip];
            }
            try { fs.unlinkSync(file.path); } catch(e) {}
            return res.json({
                ok: false,
                reason: 'FRAUDE DETETADA: Este comprovativo já foi utilizado anteriormente no sistema.',
                details: {
                    format: { ok: false, label: 'Anti-Fraude', value: 'Falhou: Comprovativo Duplicado' },
                    recipient: { ok: false, label: 'Destinatário', value: 'Bloqueado' },
                    amount: { ok: false, label: 'Valor da Transação', value: 'Bloqueado' },
                    date: { ok: false, label: 'Data da Operação', value: 'Bloqueado' },
                    terms: { ok: false, label: 'Status Final', value: 'Suspenso' }
                }
            });
        }

        // Extract Text
        let extractedText = "";
        try {
            const dataBuffer = fs.readFileSync(file.path);
            const isPdf = dataBuffer.length > 4 && dataBuffer.toString('ascii', 0, 4) === '%PDF';

            if (file.mimetype === 'application/pdf' || isPdf) {
                const data = await pdfParse(dataBuffer);
                extractedText = data.text;
            } else if (file.mimetype.startsWith('image/') || file.mimetype === 'application/octet-stream') {
                // PRÉ-PROCESSAMENTO: Ampliar imagem 3x, escala de cinza, alto contraste
                const enhancedPath = file.path + '_enhanced.png';
                let ocrPath = file.path;
                
                try {
                    await sharp(file.path)
                        .resize({ width: 3000, withoutEnlargement: false })
                        .grayscale()
                        .normalize()
                        .sharpen({ sigma: 2 })
                        .toFile(enhancedPath);
                    ocrPath = enhancedPath;
                } catch (sharpErr) {
                    console.error("Aviso: Falha no pré-processamento de imagem, usando imagem original.", sharpErr.message);
                }
                
                const { data: { text } } = await Tesseract.recognize(ocrPath, 'por');
                extractedText = text;
                
                // Limpar ficheiro temporário
                if (ocrPath === enhancedPath) {
                    try { fs.unlinkSync(enhancedPath); } catch(e) {}
                }
            } else {
                return res.status(400).json({ ok: false, reason: 'Formato de arquivo não suportado.' });
            }
        } catch (e) {
            console.error("Extraction error:", e);
            return res.status(500).json({ ok: false, reason: 'Falha ao processar o arquivo (corrompido ou ilegível).' });
        }

        const validationResult = evaluateReceiptData(extractedText, file.originalname, file.size);

        if (!validationResult.ok) {
            // Increment failed attempts
            failedAttempts[ip] = (failedAttempts[ip] || 0) + 1;
            if (failedAttempts[ip] >= 3) {
                blockList[ip] = Date.now() + 3600000; // block for 1 hour
                delete failedAttempts[ip];
            }
            return res.json(validationResult);
        }

        // On Success, generate PDF
        // Reset attempts
        delete failedAttempts[ip];

        // Registar Hash na Base de Dados para prevenir reutilização
        usedReceipts.add(fileHash);
        fs.writeFileSync(DB_FILE, JSON.stringify([...usedReceipts]));

        const token = generateToken(name, whatsapp);
        const originalPdfPath = path.join(__dirname, 'assets', 'ebook_original.pdf');
        
        const existingPdfBytes = fs.readFileSync(originalPdfPath);
        const pdfDoc = await PDFDocument.load(existingPdfBytes);
        const pages = pdfDoc.getPages();

        const stamp = name.toUpperCase() + " - LICENCA PESSOAL EXCLUSIVA - WHATSAPP: " + whatsapp + " - TOKEN: " + token;

        for (const page of pages) {
            const { width, height } = page.getSize();
            page.drawText(stamp, {
                x: width / 12,
                y: height / 4,
                size: 11,
                rotate: degrees(45),
                color: rgb(0.83, 0.68, 0.21),
                opacity: 0.16,
            });
            page.drawText(stamp, {
                x: width / 12,
                y: (3 * height) / 4,
                size: 11,
                rotate: degrees(45),
                color: rgb(0.83, 0.68, 0.21),
                opacity: 0.16,
            });
        }

        const pdfBytes = await pdfDoc.save();
        const base64Pdf = Buffer.from(pdfBytes).toString('base64');

        // Cleanup temp file
        fs.unlinkSync(file.path);

        return res.json({
            ok: true,
            token: token,
            pdfBase64: base64Pdf,
            filename: `Como_Fazer_o_Cliente_Sentir_que_Precisa_de_Voce_${name.replace(/\s+/g, '_')}.pdf`
        });

    } catch (error) {
        console.error("Server error:", error);
        try { if (req.file) fs.unlinkSync(req.file.path); } catch(e) {}
        res.status(500).json({ ok: false, reason: 'Erro interno no servidor.' });
    }
});

app.listen(port, () => {
    console.log(`Secured backend running on http://localhost:${port}`);
});
