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

// Configuração para o Render identificar o IP correto de cada usuário
app.set('trust proxy', true);

// ==================== CONFIGURAÇÃO ADMIN ====================
const ADMIN_PASSWORD = '3A11199903052025';
const PRICE_PER_SALE = 2490; // Preço em Kz

// ==================== MIDDLEWARE ====================
app.get('/', (req, res) => {
    res.send('O cérebro da Inteligência Artificial está online e a funcionar! 🚀');
});

app.use(cors());
app.use(express.json());

// ==================== STORAGE CONFIG ====================
// Guardar comprovativos em pastas organizadas
const uploadsDir = path.join(__dirname, 'uploads');
const approvedDir = path.join(uploadsDir, 'aprovados');
const rejectedDir = path.join(uploadsDir, 'rejeitados');

// Criar directórios se não existirem
[uploadsDir, approvedDir, rejectedDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const upload = multer({ dest: uploadsDir });

// ==================== BASE DE DADOS: COMPROVATIVOS USADOS ====================
const DB_FILE = path.join(__dirname, 'used_receipts.json');
let usedReceipts = new Set();
if (fs.existsSync(DB_FILE)) {
    try {
        usedReceipts = new Set(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
    } catch(e) {}
}

// ==================== BASE DE DADOS: VENDAS ====================
const SALES_FILE = path.join(__dirname, 'sales.json');
let salesDB = [];
if (fs.existsSync(SALES_FILE)) {
    try {
        salesDB = JSON.parse(fs.readFileSync(SALES_FILE, 'utf8'));
    } catch(e) { salesDB = []; }
}

function saveSalesDB() {
    fs.writeFileSync(SALES_FILE, JSON.stringify(salesDB, null, 2));
}

function addSale(saleData) {
    const sale = {
        id: 'SALE-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase(),
        timestamp: new Date().toISOString(),
        ...saleData
    };
    salesDB.push(sale);
    saveSalesDB();
    return sale;
}



// ==================== FUNÇÕES UTILITÁRIAS ====================
function getFileHash(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    const hashSum = crypto.createHash('sha256');
    hashSum.update(fileBuffer);
    return hashSum.digest('hex');
}

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
    
    const dateFormats = [
        `${dd}/${mm}/${yyyy}`,
        `${dd}-${mm}-${yyyy}`,
        `${yyyy}-${mm}-${dd}`,
        `${dd}/${mm}/${String(yyyy).slice(-2)}`,
        `${dd}-${mm}-${String(yyyy).slice(-2)}`,
        'hoje', 'today'
    ];
    
    const dateOk = dateFormats.some(df => cleanText.includes(df.replace(/[\/\-]/g, '')) || originalText.includes(df));
    const dateText = dateOk ? `✓ Data Válida (Pagamento de Hoje: ${dd}/${mm}/${yyyy})` : '✗ Data Inválida (Apenas pagamentos feitos hoje são aceites)';

    // 4. Verificação de Conclusão de Pagamento
    const successTerms = ['sucesso', 'concluid', 'concluíd', 'realizada', 'estado:sucesso', 'comprovativo', 'recibo', 'transferencia', 'transferência'];
    const successOk = successTerms.some(term => cleanText.includes(term.replace(/[\s\:]/g, '')) || originalText.includes(term));
    const termsText = successOk ? '✓ Transação Concluída com Sucesso' : '✗ Transação Incompleta (Aguardando conclusão)';

    // Anti-fraude básico
    const bad = ['fake', 'test', 'sample', 'demo', 'placeholder', 'lorem', 'comprovativo_falso', 'falso'];
    const fileNameLower = originalName.toLowerCase();
    let nameSuspect = bad.some(word => fileNameLower.includes(word));

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

// Mover ficheiro para pasta organizada
function moveReceiptFile(tempPath, targetDir, saleId, originalName) {
    const ext = path.extname(originalName) || '.png';
    const newName = saleId + ext;
    const newPath = path.join(targetDir, newName);
    try {
        fs.copyFileSync(tempPath, newPath);
        fs.unlinkSync(tempPath);
        return newName;
    } catch(e) {
        console.error('Erro ao mover ficheiro:', e.message);
        return null;
    }
}

// Gerar PDF do eBook com marca d'água
async function generateEbookPDF(name, whatsapp, token) {
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
    return Buffer.from(pdfBytes).toString('base64');
}

// ==================== ROTA PRINCIPAL: VERIFICAR COMPROVATIVO ====================
app.post('/api/verify-receipt', upload.single('receipt'), async (req, res) => {

    try {
        const { name, whatsapp } = req.body;
        const file = req.file;

        if (!file || !name || !whatsapp) {
            return res.status(400).json({ ok: false, reason: 'Dados incompletos.' });
        }



        // Método de pagamento (enviado pelo frontend)
        const paymentMethod = req.body.paymentMethod || 'Desconhecido';

        // Anti-Fraud: Duplicate Image Check (Hash Verification)
        const fileHash = getFileHash(file.path);
        if (usedReceipts.has(fileHash)) {


            // Gravar tentativa de fraude na base de dados
            const saleId = 'FRAUD-' + Date.now().toString(36).toUpperCase();
            const receiptFile = moveReceiptFile(file.path, rejectedDir, saleId, file.originalname);
            addSale({
                nome: name,
                whatsapp: whatsapp,
                metodo_pagamento: paymentMethod,
                status: 'fraude',
                motivo: 'Comprovativo duplicado (já utilizado anteriormente)',
                comprovativo: receiptFile,
                ip: ip,
                token: null
            });

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
                
                // Limpar ficheiro temporário do enhanced
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


            // Gravar venda rejeitada na base de dados (mover comprovativo para pasta de rejeitados)
            const saleId = 'REJ-' + Date.now().toString(36).toUpperCase();
            const receiptFile = moveReceiptFile(file.path, rejectedDir, saleId, file.originalname);
            addSale({
                nome: name,
                whatsapp: whatsapp,
                metodo_pagamento: paymentMethod,
                status: 'rejeitado',
                motivo: validationResult.reason,
                detalhes_validacao: validationResult.details,
                comprovativo: receiptFile,
                ip: ip,
                token: null
            });

            return res.json(validationResult);
        }

        // ==================== SUCESSO ====================
        delete failedAttempts[whatsapp];

        // Registar Hash na Base de Dados para prevenir reutilização
        usedReceipts.add(fileHash);
        fs.writeFileSync(DB_FILE, JSON.stringify([...usedReceipts]));

        const token = generateToken(name, whatsapp);
        const base64Pdf = await generateEbookPDF(name, whatsapp, token);

        // Mover comprovativo para pasta de aprovados
        const saleId = 'APR-' + Date.now().toString(36).toUpperCase();
        const receiptFile = moveReceiptFile(file.path, approvedDir, saleId, file.originalname);
        
        // Gravar venda aprovada na base de dados
        addSale({
            nome: name,
            whatsapp: whatsapp,
            metodo_pagamento: paymentMethod,
            status: 'aprovado',
            motivo: 'Aprovado automaticamente pela IA',
            comprovativo: receiptFile,
            ip: ip,
            token: token
        });

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

// ==================== MIDDLEWARE DE AUTENTICAÇÃO ADMIN ====================
function adminAuth(req, res, next) {
    const password = req.headers['x-admin-password'] || req.query.password;
    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ ok: false, reason: 'Senha de administrador incorreta.' });
    }
    next();
}

// ==================== ROTAS ADMIN ====================

// Login - verificar senha
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        return res.json({ ok: true });
    }
    return res.status(401).json({ ok: false, reason: 'Senha incorreta.' });
});

// Obter todas as vendas + estatísticas
app.get('/api/admin/sales', adminAuth, (req, res) => {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    // Cálculos de estatísticas
    const totalSales = salesDB.length;
    const approved = salesDB.filter(s => s.status === 'aprovado');
    const rejected = salesDB.filter(s => s.status === 'rejeitado');
    const fraud = salesDB.filter(s => s.status === 'fraude');
    const manualApproved = salesDB.filter(s => s.status === 'aprovado_manual');

    const allApproved = [...approved, ...manualApproved];
    const totalRevenue = allApproved.length * PRICE_PER_SALE;

    // Vendas de hoje
    const todaySales = salesDB.filter(s => s.timestamp && s.timestamp.startsWith(todayStr));
    const todayApproved = todaySales.filter(s => s.status === 'aprovado' || s.status === 'aprovado_manual');
    const todayRevenue = todayApproved.length * PRICE_PER_SALE;

    // Vendas dos últimos 7 dias (para gráfico)
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const dayStr = d.toISOString().split('T')[0];
        const dayLabel = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
        const daySales = salesDB.filter(s => s.timestamp && s.timestamp.startsWith(dayStr));
        const dayApproved = daySales.filter(s => s.status === 'aprovado' || s.status === 'aprovado_manual').length;
        const dayRejected = daySales.filter(s => s.status === 'rejeitado' || s.status === 'fraude').length;
        last7Days.push({ date: dayLabel, aprovadas: dayApproved, rejeitadas: dayRejected });
    }

    // Vendas dos últimos 30 dias (para gráfico mensal)
    const last30Days = [];
    for (let i = 29; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const dayStr = d.toISOString().split('T')[0];
        const dayLabel = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
        const daySales = salesDB.filter(s => s.timestamp && s.timestamp.startsWith(dayStr));
        const dayApproved = daySales.filter(s => s.status === 'aprovado' || s.status === 'aprovado_manual').length;
        last30Days.push({ date: dayLabel, aprovadas: dayApproved });
    }

    // Taxa de conversão
    const conversionRate = totalSales > 0 ? ((allApproved.length / totalSales) * 100).toFixed(1) : '0.0';

    // Métodos de pagamento
    const paymentMethods = {};
    salesDB.forEach(s => {
        const method = s.metodo_pagamento || 'Desconhecido';
        if (!paymentMethods[method]) paymentMethods[method] = { total: 0, aprovadas: 0 };
        paymentMethods[method].total++;
        if (s.status === 'aprovado' || s.status === 'aprovado_manual') paymentMethods[method].aprovadas++;
    });

    return res.json({
        ok: true,
        stats: {
            total_tentativas: totalSales,
            total_aprovadas: allApproved.length,
            total_rejeitadas: rejected.length,
            total_fraude: fraud.length,
            total_aprovadas_manual: manualApproved.length,
            faturamento_total: totalRevenue,
            faturamento_hoje: todayRevenue,
            vendas_hoje: todaySales.length,
            vendas_hoje_aprovadas: todayApproved.length,
            taxa_conversao: conversionRate,
            preco_unitario: PRICE_PER_SALE,
            metodos_pagamento: paymentMethods,
            grafico_7dias: last7Days,
            grafico_30dias: last30Days
        },
        sales: salesDB.slice().reverse() // Mais recentes primeiro
    });
});

// Aprovar manualmente uma venda rejeitada
app.post('/api/admin/approve', adminAuth, async (req, res) => {
    const { saleId } = req.body;
    if (!saleId) {
        return res.status(400).json({ ok: false, reason: 'ID da venda não fornecido.' });
    }

    const saleIndex = salesDB.findIndex(s => s.id === saleId);
    if (saleIndex === -1) {
        return res.status(404).json({ ok: false, reason: 'Venda não encontrada.' });
    }

    const sale = salesDB[saleIndex];
    if (sale.status === 'aprovado' || sale.status === 'aprovado_manual') {
        return res.status(400).json({ ok: false, reason: 'Esta venda já foi aprovada.' });
    }

    try {
        // Gerar token e PDF
        const token = generateToken(sale.nome, sale.whatsapp);
        const base64Pdf = await generateEbookPDF(sale.nome, sale.whatsapp, token);

        // Mover comprovativo de rejeitados para aprovados
        if (sale.comprovativo) {
            const oldPath = path.join(rejectedDir, sale.comprovativo);
            const newPath = path.join(approvedDir, sale.comprovativo);
            try {
                if (fs.existsSync(oldPath)) {
                    fs.copyFileSync(oldPath, newPath);
                    fs.unlinkSync(oldPath);
                }
            } catch(e) { console.error('Erro ao mover comprovativo:', e.message); }
        }

        // Atualizar registo
        salesDB[saleIndex].status = 'aprovado_manual';
        salesDB[saleIndex].motivo = 'Aprovado manualmente pelo administrador';
        salesDB[saleIndex].token = token;
        salesDB[saleIndex].data_aprovacao_manual = new Date().toISOString();
        saveSalesDB();

        // Registar hash se houver comprovativo (para prevenir reutilização)
        if (sale.comprovativo) {
            const approvedPath = path.join(approvedDir, sale.comprovativo);
            if (fs.existsSync(approvedPath)) {
                const hash = getFileHash(approvedPath);
                usedReceipts.add(hash);
                fs.writeFileSync(DB_FILE, JSON.stringify([...usedReceipts]));
            }
        }

        return res.json({
            ok: true,
            token: token,
            pdfBase64: base64Pdf,
            filename: `Como_Fazer_o_Cliente_Sentir_que_Precisa_de_Voce_${sale.nome.replace(/\s+/g, '_')}.pdf`,
            message: `Venda de ${sale.nome} aprovada com sucesso!`
        });

    } catch(error) {
        console.error('Erro na aprovação manual:', error);
        return res.status(500).json({ ok: false, reason: 'Erro ao gerar o PDF.' });
    }
});

// Eliminar uma venda do registo
app.delete('/api/admin/sale/:saleId', adminAuth, (req, res) => {
    const { saleId } = req.params;
    const saleIndex = salesDB.findIndex(s => s.id === saleId);
    if (saleIndex === -1) {
        return res.status(404).json({ ok: false, reason: 'Venda não encontrada.' });
    }

    // Eliminar ficheiro do comprovativo se existir
    const sale = salesDB[saleIndex];
    if (sale.comprovativo) {
        const pathApproved = path.join(approvedDir, sale.comprovativo);
        const pathRejected = path.join(rejectedDir, sale.comprovativo);
        try { if (fs.existsSync(pathApproved)) fs.unlinkSync(pathApproved); } catch(e) {}
        try { if (fs.existsSync(pathRejected)) fs.unlinkSync(pathRejected); } catch(e) {}
    }

    salesDB.splice(saleIndex, 1);
    saveSalesDB();

    return res.json({ ok: true, message: 'Venda eliminada com sucesso.' });
});

// Servir imagens de comprovativos (protegido)
app.get('/api/admin/receipt/:folder/:filename', adminAuth, (req, res) => {
    const { folder, filename } = req.params;
    let dir;
    if (folder === 'aprovados') dir = approvedDir;
    else if (folder === 'rejeitados') dir = rejectedDir;
    else return res.status(400).json({ ok: false, reason: 'Pasta inválida.' });

    const filePath = path.join(dir, filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ ok: false, reason: 'Ficheiro não encontrado.' });
    }
    res.sendFile(filePath);
});

// ==================== INICIAR SERVIDOR ====================
app.listen(port, () => {
    console.log(`Secured backend running on http://localhost:${port}`);
    console.log(`📊 Admin Panel: Use /admin.html with password to access dashboard`);
    console.log(`💾 Sales database: ${salesDB.length} records loaded`);
});
