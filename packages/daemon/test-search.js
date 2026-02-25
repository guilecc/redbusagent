import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  await page.goto("https://search.brave.com/search?q=apple+inc+latest+news", { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000); 
  
  const content = await page.content();
  console.log("HTML length:", content.length);
  const titleMatch = content.match(/<title>(.*?)<\/title>/);
  console.log("Title:", titleMatch ? titleMatch[1] : null);
  
  if (content.includes('captcha') || content.includes('challenge')) {
      console.log("Found captcha/challenge words in HTML");
  } else {
      console.log("No obvious captchas. Snippet snippet class exists?", content.includes('class="snippet"'));
  }
  
  await browser.close();
})();
