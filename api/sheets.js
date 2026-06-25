// api/sheets.js - Vercel Serverless Function
// Schreibt eBay-Verkaufsdaten in Google Sheets

export default async function handler(req, res) {
  // CORS für die PWA erlauben
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { password, sheetId, data } = req.body || {};

  // Passwortschutz
  const APP_PASSWORD = process.env.APP_PASSWORD;
  if (APP_PASSWORD && password !== APP_PASSWORD) {
    return res.status(401).json({ error: 'Falsches Passwort' });
  }

  if (!sheetId) return res.status(400).json({ error: 'sheetId fehlt' });
  if (!data?.sku) return res.status(400).json({ error: 'SKU fehlt in den Daten' });

  try {
    const token = await getGoogleToken();
    const sheetsBase = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`;
    const STOCK_SHEET = 'Stock/Lagerbestand + Ankauf, etc';
    const SOLD_SHEET  = 'Current Quarter Sold';

    // 1. Alle Daten aus Stock-Blatt lesen (Spalten A bis AZ, erste 500 Zeilen)
    const readResp = await gFetch(
      `${sheetsBase}/values/${encodeURIComponent("'" + STOCK_SHEET + "'!A1:AZ500")}`,
      token
    );
    const rows = readResp.values || [];

    // 2. Zeile mit passender SKU finden (Spalte B = Index 1, 0-basiert)
    // SKU-Spalte ist B (Index 1) basierend auf der Tabellenstruktur
    let rowIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      const cellVal = (rows[i][11] || '').toString().trim(); // Spalte B
      if (cellVal.toLowerCase() === data.sku.toLowerCase().trim()) {
        rowIndex = i;
        break;
      }
    }

    if (rowIndex === -1) {
      return res.status(404).json({ error: `SKU "${data.sku}" nicht in Tabelle gefunden` });
    }

    const sheetRowNum = rowIndex + 1; // 1-basiert für Sheets API

    // 3. Werte in die richtigen Spalten schreiben
    // Spalte C = Datum, U = Gesamtbetrag, V = Transaktionsgebühr,
    // W = Anzeigengebühr, X = Versand, Y = Versandetikett, Z = Bestelleinnahmen
    const updates = [
      { range: `${STOCK_SHEET}!C${sheetRowNum}`, value: data.datum || '' },
      { range: `${STOCK_SHEET}!U${sheetRowNum}`, value: parseFloat(data.gesamtbetrag) || '' },
      { range: `${STOCK_SHEET}!V${sheetRowNum}`, value: parseFloat(data.transaktionsgebuehr) || '' },
      { range: `${STOCK_SHEET}!W${sheetRowNum}`, value: parseFloat(data.anzeigengebuehr) || '' },
      { range: `${STOCK_SHEET}!X${sheetRowNum}`, value: parseFloat(data.versand) || '' },
      { range: `${STOCK_SHEET}!Y${sheetRowNum}`, value: parseFloat(data.versandetikett) || '' },

    ];

    const batchBody = {
      valueInputOption: 'USER_ENTERED',
      data: updates.map(u => ({
        range: `'${u.range.split('!')[0]}'!${u.range.split('!')[1]}`,
        values: [[u.value]]
      }))
    };

    // Batch-Update für alle Zahlenwerte
    await gFetch(`${sheetsBase}/values:batchUpdate`, token, 'POST', {
      valueInputOption: 'USER_ENTERED',
      data: updates.map(u => ({
        range: sheetRange(STOCK_SHEET, u.range.split('!')[1]),
        values: [[u.value]]
      }))
    });

    // 4. Spalte H auf "Verkauft + 14 Tage Rückgabezeitraum" setzen
    // (Dropdown-Wert direkt schreiben - Google Sheets akzeptiert gültige Dropdown-Werte als Text)
    await gFetch(`${sheetsBase}/values:batchUpdate`, token, 'POST', {
      valueInputOption: 'USER_ENTERED',
      data: [{
        range: sheetRange(STOCK_SHEET, `H${sheetRowNum}`),
        values: [['Verkauft + 14 Tage Rückgabezeitraum']]
      }]
    });

    // 5. Die vollständige Zeile aus Stock-Blatt lesen (für das Kopieren)
    const rowResp = await gFetch(
      `${sheetsBase}/values/${encodeSheetRange(STOCK_SHEET, `A${sheetRowNum}:AZ${sheetRowNum}`)}`,
      token
    );
    const rowData = rowResp.values?.[0] || [];

    // 6. Erste leere Zeile in Current Quarter Sold finden
    const soldResp = await gFetch(
      `${sheetsBase}/values/${encodeSheetRange(SOLD_SHEET, 'A1:A500')}`,
      token
    );
    const soldRows = soldResp.values || [];
    const firstEmptyInSold = soldRows.length + 1;

    // 7. Zeile in Current Quarter Sold einfügen
    await gFetch(`${sheetsBase}/values:batchUpdate`, token, 'POST', {
      valueInputOption: 'USER_ENTERED',
      data: [{
        range: sheetRange(SOLD_SHEET, `A${firstEmptyInSold}`),
        values: [rowData]
      }]
    });

    // 8. Zeile aus Stock-Blatt löschen
    // Zuerst Sheet-ID ermitteln
    const metaResp = await gFetch(`${sheetsBase}?fields=sheets.properties`, token);
    const sheets = metaResp.sheets || [];
    const stockSheet = sheets.find(s => s.properties.title === STOCK_SHEET);

    if (stockSheet) {
      await gFetch(`${sheetsBase}:batchUpdate`, token, 'POST', {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: stockSheet.properties.sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex,     // 0-basiert
              endIndex: rowIndex + 1
            }
          }
        }]
      });
    }

    return res.status(200).json({
      success: true,
      row: sheetRowNum,
      sku: data.sku,
      rowsWritten: 7,
      movedToRow: firstEmptyInSold
    });

  } catch (err) {
    console.error('Sheets error:', err);
    return res.status(500).json({ error: err.message || 'Unbekannter Fehler' });
  }
}

// Google OAuth2 Token über Service Account
async function getGoogleToken() {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  if (!serviceAccount.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON fehlt in Umgebungsvariablen');

  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));

  const signInput = `${header}.${payload}`;
  const privateKey = await importPrivateKey(serviceAccount.private_key);
  const signature = await signJWT(signInput, privateKey);
  const jwt = `${signInput}.${signature}`;

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });

  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) throw new Error('Google Auth fehlgeschlagen: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

async function importPrivateKey(pem) {
  const pemContents = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', binaryDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

async function signJWT(data, key) {
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function gFetch(url, token, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.error?.message || `Google API Fehler ${resp.status}`);
  return json;
}

function encodeSheetRange(sheet, range) {
  // For use in URL paths - encode the whole thing
  return encodeURIComponent(`'${sheet}'!${range}`);
}

function sheetRange(sheet, range) {
  // For use in request bodies - no URL encoding needed
  return `'${sheet}'!${range}`;
}
