// extract.js - Vercel Serverless Function
// Proxy für Claude API Calls (löst CORS-Problem)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { password, img1, img2, mime1, mime2 } = req.body || {};

  // Passwortschutz
  const APP_PASSWORD = process.env.APP_PASSWORD;
  if (APP_PASSWORD && password !== APP_PASSWORD) {
    return res.status(401).json({ error: 'Falsches Passwort' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY fehlt in Umgebungsvariablen' });

  const prompt = `Analysiere diese zwei eBay-Screenshots und extrahiere folgende Felder als JSON.
Antworte NUR mit dem JSON-Objekt, ohne Erklärung, ohne Markdown.

Screenshot 1 enthält:
- sku: der Wert direkt hinter "Bestandseinheit (SKU):"
- datum: das Datum direkt hinter "Käufer hat bezahlt" (Format: TT. Mon JJJJ)
- bestellnummer: der Wert hinter "Bestellnummer"

Screenshot 2 enthält:
- gesamtbetrag: Zahl hinter "Gesamtbetrag" im Abschnitt "Vom Käufer bezahlt" (ohne €, Komma als Dezimaltrennzeichen → Punkt verwenden)
- transaktionsgebuehr: Zahl hinter "Transaktionsgebühren" (ohne - und €, positiver Wert)
- anzeigengebuehr: Zahl hinter "Anzeigengebühr Basis" (ohne - und €, positiver Wert)
- versand: Zahl hinter "Versand" im Abschnitt "Vom Käufer bezahlt" (ohne €)
- versandetikett: Zahl hinter "Versandetikett" (ohne - und €, positiver Wert)

Alle Zahlen als Dezimalzahl mit Punkt statt Komma. Beispiel: 34.99 statt 34,99`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime1, data: img1 } },
            { type: 'image', source: { type: 'base64', media_type: mime2, data: img2 } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || `Claude API Fehler ${resp.status}`);

    const text = data.content[0].text.replace(/```json|```/g, '').trim();
    const extracted = JSON.parse(text);
    return res.status(200).json({ success: true, data: extracted });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
