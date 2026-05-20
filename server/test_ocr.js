const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');

const uploadsDir = path.join(__dirname, 'uploads');
const files = fs.readdirSync(uploadsDir).filter(f => !f.includes('enhanced')).map(f => ({
    name: f,
    time: fs.statSync(path.join(uploadsDir, f)).mtime.getTime()
})).sort((a, b) => b.time - a.time);

const testFile = path.join(uploadsDir, files[0].name);
console.log(`\n📂 A analisar: ${files[0].name} (${fs.statSync(testFile).size} bytes)\n`);

async function run() {
    let text = "";
    const dataBuffer = fs.readFileSync(testFile);
    const isPdf = dataBuffer.length > 4 && dataBuffer.toString('ascii', 0, 4) === '%PDF';

    if (isPdf) {
        console.log("📄 Identificado como PDF! A extrair texto bruto...");
        const data = await pdfParse(dataBuffer);
        text = data.text;
    } else {
        console.log("🖼️ Identificado como Imagem. A pré-processar com Sharp...");
        const enhancedPath = testFile + '_enhanced.png';
        let ocrPath = testFile;
        try {
            await sharp(testFile)
                .resize({ width: 3000, withoutEnlargement: false })
                .grayscale()
                .normalize()
                .sharpen({ sigma: 2 })
                .toFile(enhancedPath);
            ocrPath = enhancedPath;
        } catch(e) {
            console.log("Aviso: Sharp falhou:", e.message);
        }
        
        console.log("🧠 A executar Tesseract OCR (pt)...");
        const { data: { text: ocrText } } = await Tesseract.recognize(ocrPath, 'por');
        text = ocrText;
        if (ocrPath === enhancedPath) try { fs.unlinkSync(enhancedPath); } catch(e){}
    }

    console.log("=".repeat(60));
    console.log("📄 TEXTO EXTRAÍDO:\n");
    console.log(text);
    console.log("=".repeat(60));
}

run().catch(console.error);
