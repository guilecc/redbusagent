import * as cheerio from 'cheerio';
import fs from 'fs';

(async () => {
    const query = "Apple Inc latest news";
    const formData = new URLSearchParams();
    formData.append('q', query);

    const res = await fetch('https://lite.duckduckgo.com/lite/', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        body: formData.toString()
    });

    const html = await res.text();
    fs.writeFileSync('ddg-lite.html', html);
    console.log("HTML length:", html.length);
})();
