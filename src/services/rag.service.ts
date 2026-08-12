import fs from 'fs';
import path from 'path';
import crypto from 'crypto'; // REQUIRED: For randomUUID
import { z } from 'zod';
import { ChatDeepSeek } from '@langchain/deepseek';
import { PromptTemplate } from '@langchain/core/prompts';
import { chromium, Browser, Page } from 'playwright';
import stealth from 'puppeteer-extra-plugin-stealth';
import { chromium as playwrightExtra } from 'playwright-extra';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { encoding_for_model, Tiktoken } from "tiktoken";
import geoip from 'geoip-country'; 
import pino from 'pino';
import pLimit from 'p-limit'; // REQUIRED: For concurrency control
import { performance } from 'node:perf_hooks';
import { prisma } from '../lib/prisma.js';
import { Stage1AnalysisSchema, Stage2SynthesisSchema, FinalAnswerSchema } from '../utils/schemas.js';
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase Storage Client
// Note: We use the SERVICE_ROLE_KEY to write to the private bucket
const supabase = createClient(
  process.env.SUPABASE_URL!, 
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// --- 1. CENTRAL CONFIGURATION ---
const CONFIG = {
  TIMEOUTS: {
    NAV_GOTO: 20000,
    LLMS_TXT: 4000,
    HYDRATION: 4000,
    POPUP_CLICK: 2000,
    // NEW: Strict limit ONLY for the browser part.
    // The LLM part is now unlimited ("Enough Thinking").
    BROWSER_HARD_LIMIT: 60000,
  },
  LIMITS: {
    MAX_TOKENS_CONTEXT: 64000,
    MAX_SCROLL_HEIGHT: 5000,
    MAX_RETRIES: 2,
    // NEW: Restart browser after this many pages to prevent Memory Leaks
    BROWSER_RESTART_THRESHOLD: 12, 
  },
  SCROLL: {
    DISTANCE: 100,
    INTERVAL_MS: 50,
  },
  HYDRATION: {
    CHECK_INTERVAL_MS: 500,
    STABLE_COUNT_THRESHOLD: 2,
  }
};

// --- 2. LOGGING SETUP ---
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true }
  }
});

playwrightExtra.use(stealth());

const turndownService = new TurndownService();
// Optimization: Instantiate Tokenizer Encoder ONCE
const TIKTOKEN_ENCODER: Tiktoken = encoding_for_model("gpt-4");

// Optimization: Cache for llms.txt check
const llmsCache = new Map<string, boolean>();

// --- GLOBAL CONCURRENCY LIMIT (FREE TIER FIX) ---
// We move this OUT of the class so it is shared across all requests.
// Limit set to 2 to prevent OOM on 512MB RAM instances.
const GLOBAL_BROWSER_LIMIT = pLimit(3);

interface SearchResult {
  title: string;
  link: string;
  snippet: string;
}

function loadPrompt(fileName: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'src', 'prompts', fileName), 'utf-8');
}

// Optimization: Strict Token Truncation Helper
function truncateToTokens(text: string, maxTokens: number): string {
  const encoder = TIKTOKEN_ENCODER;
  const tokens = encoder.encode(text);
  if (tokens.length <= maxTokens) return text;
  const slicedTokens = tokens.slice(0, maxTokens);
  return new TextDecoder().decode(encoder.decode(slicedTokens));
}

function getSearchEngine(ip: string): "google" | "baidu" {
  if (ip === '::1' || ip === '127.0.0.1') {
    logger.info(`[GEO] Localhost detected. Defaulting to Google.`);
    return 'google';
  }
  const geo = geoip.lookup(ip);
  if (geo && geo.country === 'CN') {
    logger.info(`[GEO] IP ${ip} is in China. Switching to Baidu.`);
    return 'baidu';
  }
  logger.info(`[GEO] IP ${ip} is in ${geo?.country || 'Unknown'}. Using Google.`);
  return 'google';
}

// Updated Return Type to Promise<SearchResult[]>
async function searchWeb(query: string, engine: "google" | "baidu" | "bing"): Promise<SearchResult[]> {
  const apiKey = process.env.SERPAPI_API_KEY!; // Validated at top level
  
  const params = new URLSearchParams({
    engine: engine,
    q: query,
    api_key: apiKey,
    num: "10"
  });

  logger.info(`[SEARCH] Querying SerpApi with engine: ${engine}`);
  const response = await fetch(`https://serpapi.com/search?${params}`);
  if (!response.ok) throw new Error(`SerpApi failed: ${response.statusText}`);
  
  const data = await response.json();
  if (!data.organic_results) return [];
  
  // Explicit mapping guarantees shape matches SearchResult interface
  return data.organic_results.map((r: any) => ({
    title: r.title,
    link: r.link,
    snippet: r.snippet
  }));
}

export class RAGService {
  private model: ChatDeepSeek;
  private static browser: Browser | null = null;
  // NEW: Track usage to restart browser periodically
  private static requestCount: number = 0; 

  constructor() {
    // --- 3. STARTUP VALIDATION (Fail Fast) ---
    const requiredEnvVars = ['DIRECT_URL', 'DEEPSEEK_API_KEY', 'SERPAPI_API_KEY'];
    const missingVars = requiredEnvVars.filter(key => !process.env[key]);

    if (missingVars.length > 0) {
      logger.fatal(`[SYSTEM] Missing required environment variables: ${missingVars.join(', ')}`);
      process.exit(1); // Crash immediately so ops knows something is wrong
    }
    
    this.model = new ChatDeepSeek({
      model: 'deepseek-chat',
      temperature: 1.0,
      apiKey: process.env.DEEPSEEK_API_KEY,
      maxTokens: 8000
    });
  }

  // --- SINGLETON BROWSER MANAGEMENT ---
  private async getBrowser(): Promise<Browser> {
    // NEW: Lifecycle Management (Restart if used too many times)
    if (RAGService.browser && RAGService.requestCount >= CONFIG.LIMITS.BROWSER_RESTART_THRESHOLD) {
      logger.info('[SYSTEM] Browser usage limit reached. Recycling instance...');
      await RAGService.teardown();
      RAGService.requestCount = 0;
    }

    if (!RAGService.browser || !RAGService.browser.isConnected()) {
      logger.info('[SYSTEM] Launching Singleton Browser (Balanced Mode)...');
      
      RAGService.browser = await playwrightExtra.launch({ 
        headless: true,
        args: [
            // 1. SECURITY & PERMISSIONS (Required for Render/Docker)
            '--no-sandbox',
            '--disable-setuid-sandbox',

            // 2. MEMORY STABILITY (Prevents OOM crashes on heavy sites)
            '--disable-dev-shm-usage',

            // 3. PERFORMANCE (Saves RAM/CPU)
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-networking',
        ] 
      });
    }
    return RAGService.browser;
  }

  // NEW: Allow external scripts to safely close the browser
  public static async teardown() {
    if (RAGService.browser) {
        await RAGService.browser.close().catch(() => {});
        RAGService.browser = null;
    }
  }

  // --- 1. TRIAGE ---
  async triageUrls(query: string, searchResults: SearchResult[]): Promise<{ urls: string[], usage: any }> {
    logger.info('[RAG] Triaging search results...');
    const template = PromptTemplate.fromTemplate(loadPrompt('p1-triage.txt'));
    const formattedPrompt = await template.format({
      user_query: query,
      search_results: JSON.stringify(searchResults)
    });

    const response = await this.model.invoke(formattedPrompt);
    
    // Capture token usage for cost calculation
    const usage = response.usage_metadata ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

    try {
      const cleanJson = (response.content as string).replace(/```json/g, '').replace(/```/g, '').trim();
      const urls = JSON.parse(cleanJson);
      return { urls: urls.slice(0, 6), usage };
    } catch (e) {
      logger.error('Triage JSON parse error, using fallback top 5');
      return { urls: searchResults.slice(0, 5).map(r => r.link), usage };
    }
  }

  // --- 2. PROCESS URL ---
  async processUrl(
    url: string, 
    query: string, 
    browser: Browser, 
    p2Template: PromptTemplate, 
    p3Template: PromptTemplate
  ) {
    logger.info(`[RAG] Processing: ${url}`);
    const origin = new URL(url).origin;
    
    let p2TokenUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    let p3TokenUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

    // --- SAFETY WRAPPER ---
    try {
        // --- OPTIMIZATION: LLMS.TXT CHECK (STARTED PARALLEL) ---
        const llmsCheckPromise = (async () => {
          if (llmsCache.has(origin)) {
            // X-RAY LOG: Cache Hit
            logger.info(`[LLMS.TXT] Cache hit for ${origin}: ${llmsCache.get(origin)}`);
            return llmsCache.get(origin)!;
          }

          for (let i = 1; i <= CONFIG.LIMITS.MAX_RETRIES; i++) {
            try {
              const response = await fetch(`${origin}/llms.txt`, { 
                method: 'GET',
                signal: AbortSignal.timeout(CONFIG.TIMEOUTS.LLMS_TXT)
              });
              const contentType = response.headers.get('Content-Type') || '';
              const result = response.ok && (contentType.includes('text/plain') || contentType.includes('text/markdown'));
              llmsCache.set(origin, result);
              // X-RAY LOG: Network Success
              logger.info(`[LLMS.TXT] Found for ${origin}: ${result}`);
              return result;
            } catch (e) {
              if (i === CONFIG.LIMITS.MAX_RETRIES) {
                // X-RAY LOG: Network Fail
                logger.warn(`[LLMS.TXT] Failed for ${origin} after retries.`);
                llmsCache.set(origin, false);
                return false;
              }
            }
          }
          return false;
        })();

        // --- PHASE 1: SCRAPING (STRICT 60s LIMIT) ---
        // We wrap ONLY the browser logic in a timer. If Chrome hangs, we kill it.
        const p2Promise = (async () => {
            const context = await browser.newContext({ 
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36' 
            });

            let content = "";

            try {
                // START TIMER RACE
                content = await Promise.race([
                    (async () => {
                        const page = await context.newPage();
                
                // --- NEW: ENHANCED BLOCKING (Ads + SSRF) ---
                await page.route('**/*', (route) => {
                    const req = route.request();
                    const type = req.resourceType();
                    const reqUrl = req.url();
                    let hostname = '';
                    try { hostname = new URL(reqUrl).hostname; } catch(e) {}

                    // 1. Block Heavy Resources (Bandwidth)
                    if (['image', 'font', 'stylesheet', 'media'].includes(type)) {
                        return route.abort();
                    }

                    // 2. Block Ad & Tracker Domains (CPU)
                    const AD_DOMAINS = [
                        'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
                        'facebook.net', 'amazon-adsystem.com', 'criteo.com', 'chartbeat.com',
                        'rubiconproject.com', 'outbrain.com', 'taboola.com', 'adservice.google.com'
                    ];
                    if (AD_DOMAINS.some(domain => reqUrl.includes(domain))) {
                        return route.abort();
                    }
    
                    // 3. Block Local/Private IPs (SSRF Security)
                    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.startsWith('10.')) {
                        return route.abort();
                    }

                    route.continue();
                });

                // --- NAVIGATION RETRY ---
                for (let i = 1; i <= CONFIG.LIMITS.MAX_RETRIES; i++) {
                  try {
                    await page.goto(url, { timeout: CONFIG.TIMEOUTS.NAV_GOTO, waitUntil: 'domcontentloaded' });
                    break;
                  } catch (e: any) {
                    // X-RAY LOG: Nav Fail
                    logger.warn(`[NAV] Retry ${i} for ${url}: ${e.message}`);
                    if (i === CONFIG.LIMITS.MAX_RETRIES) throw e;
                  }
                }

                // --- OPTIMIZATION: POPUP CLOSER ---
                try {
                  await page.locator('button:has-text("Accept"), button:has-text("Allow"), button:has-text("Close"), [aria-label="Close"], button:has-text("I agree")')
                    .first()
                    .click({ timeout: CONFIG.TIMEOUTS.POPUP_CLICK });
                } catch (e) {}

                // --- SMART SCROLL ---
                try {
                  await page.evaluate(async (config) => {
                    await new Promise<void>((resolve) => {
                        let totalHeight = 0;
                        const timer = setInterval(() => {
                            const scrollHeight = document.body.scrollHeight;
                            window.scrollBy(0, config.SCROLL.DISTANCE);
                            totalHeight += config.SCROLL.DISTANCE;
                            if (totalHeight >= scrollHeight || totalHeight >= config.LIMITS.MAX_SCROLL_HEIGHT) {
                                clearInterval(timer);
                                resolve();
                            }
                        }, config.SCROLL.INTERVAL_MS);
                    });
                  }, CONFIG);
                } catch (e) {
                    logger.warn({ msg: 'Scroll interrupted by navigation (acceptable)', url });
                }

                // --- OPTIMIZATION: DOM STABILITY/HYDRATION CHECK ---
                try {
                  await page.evaluate(async (config) => {
                    return await new Promise<void>((resolve) => {
                      let lastLength = document.body.innerHTML.length;
                      let stableCount = 0;
                      const checkInterval = setInterval(() => {
                        const currentLength = document.body.innerHTML.length;
                        if (currentLength === lastLength) stableCount++;
                        else stableCount = 0;
                        lastLength = currentLength;
                        
                        if (stableCount >= config.HYDRATION.STABLE_COUNT_THRESHOLD) {
                          clearInterval(checkInterval);
                          resolve();
                        }
                      }, config.HYDRATION.CHECK_INTERVAL_MS);
                      
                      setTimeout(() => { 
                          clearInterval(checkInterval); 
                          resolve(); 
                      }, config.TIMEOUTS.HYDRATION);
                    });
                  }, CONFIG);
                } catch (e) {}

                const html = await page.content();
                const $ = cheerio.load(html);
                
                // --- OPTIMIZATION: EXTENSIVE NOISE REMOVAL ---
                const noiseSelectors = [
                    'img', 'svg', 'picture', 'canvas', 'video', 'audio', 'figure',
                    'form', 'input', 'textarea', 'button', 'select', 'template',
                    'link[rel="stylesheet"]', 'link[rel="icon"]', 'option', 'optgroup', 'source', 
                    '.login', '.signup', 'form[action*="login"]', 'script', 'style', 'noscript', 
                    '[role="alert"]', '#search', '.search', '.search-bar', '.search-box', 
                    '[role="search"]', '.search-form', '#ads', '.ads', '.advert', '.advertising', 
                    '.advertisement', '[class^="ad-"]', '[id^="ad-"]', '[class^="ad_"]', '[id^="ad_"]', 
                    '[class*="google-auto-placed"]', '[id*="google_ads"]', '.cpro', '.ec_ad', '[id^="dfs"]',
                    '.share-bar', '.social-share', '.share-buttons', '.social-icons', '.bdsharebuttonbox', 
                    '.jiathis_style', '[class*="social"]', '#related', '.related', '.related-posts', 
                    '.recommend', '.recommendations', '.cookie', '.cookie-banner', '.popup', '[class*="cookie"]', '[id*="cookie"]',
                    '.app-download', '.open-in-app', '.download-banner', '[class*="social"]', '[class*="promo"]','[id*="promo"]', 
                    '[class*="subscribe"]', '[id*="subscribe"]', '[class*="related-post"]', '[class*="related-articles"]',
                    '.toast', '.print-only', '.skip-link'
                ];
                $(noiseSelectors.join(', ')).remove();
                
                const contentHtml = $('body').html();
                        if (!contentHtml) return "";
                
                        const md = turndownService.turndown(contentHtml);
                        // X-RAY LOG: Scrape Success
                        logger.info(`[INGESTION] Scraped ${url} - Length: ${md.length} chars`);
                        return md;
                    })(),
                    // THE SAFETY VALVE (60s)
                    new Promise<string>((_, reject) => 
                        setTimeout(() => reject(new Error('Browser Stalled')), CONFIG.TIMEOUTS.BROWSER_HARD_LIMIT)
                    )
                ]);
                // END TIMER RACE

            } catch (e: any) {
                logger.warn({ msg: 'Browser Stalled/Failed', url, error: e.message || e });
                return null;
            } finally {
                // Always clean up RAM
                await context.close();
            }

            if (!content || content.length < 100) {
                logger.warn(`[INGESTION] Content too short (<100 chars) for ${url}. Skipping.`);
                return null;
            }

            // --- PHASE 2: "ENOUGH THINKING" (UNLIMITED TIME) ---
            // The scraping is done. The browser is closed.
            // We now let the LLM take as long as it needs. No timers here.

            const safeContent = truncateToTokens(content, CONFIG.LIMITS.MAX_TOKENS_CONTEXT);
            const p2Prompt = await p2Template.format({ user_query: query, document_text: safeContent });
            const p2Res = await this.model.invoke(p2Prompt);
            p2TokenUsage = p2Res.usage_metadata ?? p2TokenUsage;
            const relevantExcerpt = p2Res.content as string;
            return relevantExcerpt.trim() ? relevantExcerpt : null;
        })();

        // --- SYNCHRONIZATION POINT: Wait for both parallel tasks ---
        const [llmsTxtFound, relevantExcerpt] = await Promise.all([llmsCheckPromise, p2Promise]);

        if (!relevantExcerpt) return null;

        // --- STAGE 1 ANALYSIS (Prompt 3) ---
        const p3Prompt = await p3Template.format({
            source_url: url,
            user_query: query,
            relevant_excerpt: relevantExcerpt,
            json_schema: JSON.stringify(z.toJSONSchema(Stage1AnalysisSchema)),
            llms_txt_status: llmsTxtFound ? "Detected" : "Not Detected"
        });

        const p3Res = await this.model.invoke(p3Prompt, { response_format: { type: 'json_object' }});
        p3TokenUsage = p3Res.usage_metadata ?? p3TokenUsage;
        const stage1Data = JSON.parse(p3Res.content as string);
        // STRICT VALIDATION
        Stage1AnalysisSchema.parse(stage1Data);

        return {
            stage1Data: { sourceUrl: url, ...stage1Data },
            relevantExcerpt: { url, excerpt: relevantExcerpt },
            p2TokenUsage,
            p3TokenUsage
        };

    } catch (e) {
        logger.error({ msg: 'Process URL Fatal Error', url, error: e });
        return null;
    }
  }

  // --- MAIN PIPELINE ---
  async runPipeline(queryText: string, userIp: string, userId: string) {
    const startTime = performance.now();
    logger.info(`[PIPELINE] Starting for IP: ${userIp}`);
    const allTokenUsage: any[] = [];
    
    // 1. Detect Engine & Search (With Fallback)
    const engine = getSearchEngine(userIp);
    let searchResults: SearchResult[] = [];
    let usedFallback = false; // <--- Flag to track if we already tried Bing

    try {
        searchResults = await searchWeb(queryText, engine);
    } catch (e) {
        logger.warn(`[SEARCH] Primary engine ${engine} failed. Attempting fallback to Bing.`);
        try {
            usedFallback = true; // <--- Mark fallback as used
            searchResults = await searchWeb(queryText, 'bing');
        } catch (fallbackError) {
            logger.error(`[SEARCH] Fallback engine Bing also failed.`);
            throw new Error("All search providers failed.");
        }
    }
    
    if (searchResults.length === 0) {
        // If we haven't tried Bing yet (e.g. primary didn't error but just returned 0 results)
        if (!usedFallback) { 
             logger.warn(`[SEARCH] Primary engine returned 0 results. Attempting fallback to Bing.`);
             searchResults = await searchWeb(queryText, 'bing');
        }
        // If it is STILL empty after potential fallback, then throw
        if (searchResults.length === 0) throw new Error("No search results found.");
    }

    // 2. Triage
    const { urls: targetUrls, usage: p1Usage } = await this.triageUrls(queryText, searchResults);
    allTokenUsage.push(p1Usage);
    logger.info({ msg: 'Triaged URLs', count: targetUrls.length, urls: targetUrls });

    // Count usage to determine if browser needs restart next time
    RAGService.requestCount += targetUrls.length;
    
    // --- OPTIMIZATION: PRE-LOAD TEMPLATES ONCE ---
    const p2Template = PromptTemplate.fromTemplate(loadPrompt('p2-relevance-extraction.txt'));
    const p3Template = PromptTemplate.fromTemplate(loadPrompt('p3-stage1-analysis.txt'));

    // 3. Parallel Processing (Using Singleton Browser)
    const browser = await this.getBrowser();
    
    // NEW: Use GLOBAL_BROWSER_LIMIT (3) instead of creating local limit(3).
    // This prevents total RAM explosion.
    const tasks = targetUrls.map((url: string) => 
        GLOBAL_BROWSER_LIMIT(async () => {
            // REMOVED: Safety Valve (Timeout Race) Logic
            // Directly return the processUrl promise
            try {
                return await this.processUrl(url, queryText, browser, p2Template, p3Template);
            } catch (e) {
                logger.warn({ msg: 'Skipping failed URL', url, error: e });
                return null;
            }
        })
    );
    
    const results = await Promise.all(tasks);
    // Note: Do NOT close browser here. It is a singleton.

    const validResults = results.filter(r => r !== null);
    const allStage1 = validResults.map(r => r!.stage1Data);
    const allExcerpts = validResults.map(r => r!.relevantExcerpt);

    // Aggregate token usage from parallel tasks
    validResults.forEach(r => {
      if (r?.p2TokenUsage) allTokenUsage.push(r.p2TokenUsage);
      if (r?.p3TokenUsage) allTokenUsage.push(r.p3TokenUsage);
    });

    if (allStage1.length === 0) throw new Error("All sources failed processing.");

    // 4. Synthesis
    logger.info(`[PIPELINE] Synthesizing ${allStage1.length} sources...`);
    const p4Template = PromptTemplate.fromTemplate(loadPrompt('p4-stage2-synthesis.txt'));
    const p4Prompt = await p4Template.format({
        user_query: queryText,
        stage_1_json_array: JSON.stringify(allStage1),
        relevant_excerpts: JSON.stringify(allExcerpts),
        json_schema: JSON.stringify(z.toJSONSchema(Stage2SynthesisSchema))
    });
    
    const p4Res = await this.model.invoke(p4Prompt, { response_format: { type: 'json_object' }});
    allTokenUsage.push(p4Res.usage_metadata);
    
    const stage2Data = JSON.parse(p4Res.content as string);
    // STRICT VALIDATION
    Stage2SynthesisSchema.parse(stage2Data);

    // 5. Final Answer
    logger.info(`[PIPELINE] Generating Final Report...`);
    const p5Template = PromptTemplate.fromTemplate(loadPrompt('p5-final-answer.txt'));
    
    const cleanStage1 = allStage1.map(({ finalJudgmentSummary, ...rest }) => rest);
    const { finalJudgmentSummary, ...cleanStage2 } = stage2Data;
    const execSummary = `CONSENSUS: ${stage2Data.finalJudgmentSummary}\n` + 
        allStage1.map((d: any, i: number) => `SOURCE ${i+1}: ${d.finalJudgmentSummary}`).join('\n');

    const p5Prompt = await p5Template.format({
        user_query: queryText,
        full_analysis_json: JSON.stringify({
            user_query: queryText,
            stage_1_analyses: cleanStage1,
            stage_2_synthesis: cleanStage2
        }),
        relevant_excerpts: JSON.stringify(allExcerpts),
        executive_summary: execSummary,
        json_schema: JSON.stringify(z.toJSONSchema(FinalAnswerSchema))
    });

    const p5Res = await this.model.invoke(p5Prompt, { response_format: { type: 'json_object' }});
    allTokenUsage.push(p5Res.usage_metadata);
    
    const finalAnswerData = JSON.parse(p5Res.content as string);
    // STRICT VALIDATION
    FinalAnswerSchema.parse(finalAnswerData);

    // Calculate Totals for Persistence (Quietly)
    const totalUsage = allTokenUsage.reduce((acc, u) => {
    if (!u) return acc;
    acc.input_tokens += u.input_tokens ?? 0;
    acc.output_tokens += u.output_tokens ?? 0;
    acc.total_tokens += u.total_tokens ?? 0;
    acc.cache_read_input_tokens += u.input_token_details?.cache_read ?? 0;
    return acc;
}, { 
    input_tokens: 0, 
    output_tokens: 0, 
    total_tokens: 0, 
    cache_read_input_tokens: 0 // Initialize this to 0
});

    const endTime = performance.now();
    const durationMs = Math.round(endTime - startTime);
    const durationSec = (durationMs / 1000).toFixed(2);
    logger.info(`[PERFORMANCE] Pipeline finished in ${durationSec}s`);

    const fullReport = {
        originalQuery: queryText,
        ...finalAnswerData,
        sourceIntegrityReport: allStage1,
        consensusAnalysis: stage2Data,
        tokenUsage: totalUsage,
        executionTimeMs: durationMs
    };

    // --- NEW: S3 OFFLOADING PATTERN ---
    
    // 1. Generate a unique filename for the log
    const timestamp = new Date().toISOString();
    const requestId = crypto.randomUUID(); 
    const filePath = `sprint1/${timestamp}_${requestId}.json`;

    // 2. Fire-and-Forget: Upload to Storage AND Write to DB in background
    setImmediate(async () => {
        try {
            // A. Upload the heavy JSON to Supabase Storage
            const { error: uploadError } = await supabase.storage
                .from('request_logs') // The bucket you created
                .upload(filePath, JSON.stringify(fullReport, null, 2), {
                    contentType: 'application/json',
                    upsert: false
                });

            if (uploadError) {
                logger.error({ msg: "Failed to upload log to Storage", error: uploadError });
                return; // Stop if upload fails so we don't save a broken record
            }

            // B. Save ONLY the "Receipt" (Reference) to Postgres
            // We use the same 'fullReportJson' column but store a tiny pointer instead of the full blob.
            // This avoids a database migration!
            await prisma.searchReport.create({
                data: {
                    originalQuery: queryText,
                    finalAnswer: finalAnswerData.finalAnswer.text,
                    // TRICK: We store the reference object instead of the huge data
                    fullReportJson: { 
                        storage_bucket: 'request_logs', 
                        storage_path: filePath,
                        offloaded: true 
                    },

                    // NEW: Write metrics to the new dedicated columns
                    inputTokens: totalUsage.input_tokens,
                    outputTokens: totalUsage.output_tokens,
                    totalTokens: totalUsage.total_tokens,
                    
                    // NEW: Connect the report to the User
                    user: {
                        connect: { supabaseUid: userId }
                    }
                }
            });
            
        } catch (err) {
            logger.error({ msg: "Background logging failed", error: err });
        }
    });

    // 3. Return immediately (Latency Win)
    // We return the full data to the user directly from memory
    return fullReport;
  }
}

// --- SYSTEM CLEANUP HANDLERS ---
// This ensures that if the Node process is killed (Ctrl+C or Crash), 
// we scream at the browser to close first.

// 1. Clean up on normal exit
process.on('exit', () => {
    RAGService.teardown().catch(() => {});
});

// 2. Clean up on crashes or server stops (like from Docker or Render)
['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(signal => {
    process.on(signal, async () => {
        await RAGService.teardown().catch(() => {});
        process.exit(0);
    });
});