# nogeo-backend

Decoupled single-shot RAG answer engine and automated multi-stage AI reasoning pipeline that filters, evaluates, and synthesizes web sources into verifiable Trust Reports.

-----

## 📦 System Overview

The backend architecture of **Nogeo/The Glass Box** operates as a specialized analytical software application rather than a conversational chatbot. It ingests raw search results, evaluates information authority, performs dual data extraction, executes single-source forensic analysis, and strings together a composite cross-document consensus matrix. The entire pipeline runs sequentially and evaluates safety layers to provide an end-to-end verifiable snapshot.

``` 
[Search Payload] ➔ [P1: Triage Selector] ➔ [Playwright Crawler]
                                                    │
[P5: Tracer] ◀ [P4: Synthesizer] ◀ [P3: Auditor] ◀ [P2: Extractor]

```

-----

## 🛠️ Technology Stack

  * **Runtime & Framework:** Node.js, Express, TypeScript (Target: `ES2022`, Module: `NodeNext`).
  * **Database & Database ORM:** Supabase (PostgreSQL engine) connected through Prisma ORM.
  * **Orchestration & Model Stack:** LangChain framework deploying `deepseek-chat` models with structural JSON forcing.
  * **Ingestion Layer:** Playwright with `puppeteer-extra-plugin-stealth` for scraping, combined with cheerio and turndown for text conversion.
  * **Data Guard & Schema Validation:** Zod schema constraints to enforce strict format types (`Stage1AnalysisSchema`, `FinalAnswerSchema`).

-----

## 🧩 AI Prompt Pipeline Architecture

The core intellectual property consists of 5 modular, single-responsibility pipelines orchestrated sequentially:

1.  **P1: The Triage Prompt (`p1-triage.txt`)**
    Filters incoming unstructured payloads to drop streaming/video networks and isolates exactly the top 7 high-authority target URLs.
2.  **P2: The Relevance Extraction Prompt (`p2-relevance-extraction.txt`)**
    Executes a dual-pass extraction script returning literal matches mapped directly to target queries, as well as a forensic block checking for authorship, dates, and black-hat updates.
3.  **P3: The Stage 1 Analysis Prompt / The Auditor (`p3-stage1-analysis.txt`)**
    Inspects each separate document to assign dynamic authority configurations (`authorityScore`), checks for prompt injection compromises, and references site infrastructure parameters (`llms.txt`).
4.  **P4: The Stage 2 Synthesis Prompt / The Synthesizer (`p4-stage2-synthesis.txt`)**
    Evaluates facts cross-referencing all 7 sources simultaneously to deduce a mathematical `consensusScore` while docking parameters for conflicting claims.
5.  **P5: The Final Answer Prompt / The Reporter (`p5-final-answer.txt`)**
    Maps literal phrases to an atomic trace layout, building the end-user facing transparency log.

-----

## 🔐 Local Environment Configuration

Contributors must replicate variables locally. Create a `.env` file in the project's root matching the layout below:

``` bash
# Server Port Mapping Configuration
PORT=3000
NODE_ENV=development

# Database & Authentication Engines (Supabase Provider)
DATABASE_URL="postgresql://postgres:[YOUR_PASSWORD]@db.[YOUR_REF][link removed]"
SUPABASE_URL="[link removed]"
SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsIn..."

# LLM Framework & Computational Partners
DEEPSEEK_API_KEY="sk-..."
BRIGHT_DATA_SEARCH_KEY="your-bright-data-token"

# Billing Infrastructure Interface
STRIPE_API_KEY="sk_test_..."

```

> **Critical Warning:** The version control rules explicitly filter `.env` tracking blocks. Never swap out placeholder targets with production production keys when committing edits to open-source branches.

-----

## ⚙️ Development Installation & Setup

### 1\. Install Project Modules

Install all standard framework requirements and underlying stealth scraping components using Node Package Manager:

``` bash
npm install

```

### 2\. Configure Database Relations

Generate schemas and bind structural models against your Supabase deployment through Prisma's toolchain:

``` bash
npx prisma generate
npx prisma db push

```

### 3\. Initiate Automated Prompt Validation Check

The prompt systems are validated using a custom automated harness file (`sprint0-test.ts`) before compiling the main distribution bundle:

``` bash
npm run dev

```

### 4\. Build Codebase Output Bundle

Compile TypeScript assets down into high-performance native ECMAScript source modules within the `./dist` folder:

``` bash
npm run build

```
-----