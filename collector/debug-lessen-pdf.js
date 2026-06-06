require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const pdfParse = require('pdf-parse');
const fs = require('fs');

const filePath = 'C:\\Users\\drcal\\Downloads\\Bill Payment_#10326322 via ACH.pdf';

(async () => {
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  console.log('=== RAW TEXT ===\n', data.text);
  console.log('\n=== PARSED ===');

  const text = data.text;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Payment date
  const dateMatch = text.match(/Date:\s+(\d{2}\/\d{2}\/\d{4})/i);
  console.log('Payment date match:', dateMatch ? dateMatch[1] : 'NOT FOUND');

  // Work orders
  for (const line of lines) {
    const billMatch = line.match(/Bill(?:\s+Credit)?\s+(\d+)/i);
    const amtMatch  = line.match(/(-?\$?[\d,]+\.?\d*)\s*$/);
    if (billMatch && amtMatch) {
      const isCredit = /Bill Credit/i.test(line);
      const amount   = parseFloat(amtMatch[1].replace(/[$,]/g, '')) || 0;
      const final    = isCredit ? -Math.abs(amount) : Math.abs(amount);
      console.log(`  WO: ${billMatch[1]}  amount: ${final}  credit: ${isCredit}  line: "${line}"`);
    }
  }
})();
