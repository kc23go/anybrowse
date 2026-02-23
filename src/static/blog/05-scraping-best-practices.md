# SEO Blog Post 5: Web Scraping Best Practices for LLMs

**Target Keyword:** "web scraping best practices"  
**Secondary Keywords:** "llm web scraping", "scraping for ai", "clean data extraction", "scraping optimization"  
**Word Count:** ~2,500 words  
**Content Type:** Technical Best Practices

---

## URL Slug
`/blog/web-scraping-best-practices-llms`

## Meta Title (60 chars)
Web Scraping Best Practices for LLMs | anybrowse Guide

## Meta Description (155 chars)
Master web scraping for LLMs. Best practices for clean data extraction, token optimization, and reliable results. x402 micropayments. $0.002/scrape.

---

## H1: Web Scraping Best Practices for LLM Applications

### Introduction

Feeding web content into Large Language Models isn't as simple as grabbing HTML and throwing it into a prompt. Raw HTML is noisy, token-heavy, and often breaks your carefully crafted prompts.

This guide covers battle-tested best practices for extracting clean, LLM-optimized content from websites. Whether you're building RAG pipelines, training data sets, or real-time knowledge bases, these practices will improve your results and reduce costs.

**Prerequisites:**
- Basic understanding of web scraping
- anybrowse.dev account (just a wallet with USDC on Base—no signup required)
- Familiarity with LLM prompting

### H2: 1. Extract Clean Markdown, Not HTML

#### The Problem with Raw HTML

Raw HTML includes:
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <script src="analytics.js"></script>
    <style>body{font-family:Arial}</style>
</head>
<body>
    <nav><!-- 50 lines of navigation --></nav>
    <article>
        <h1>Actual Content</h1>
        <p>This is what you want...</p>
    </article>
    <footer><!-- 30 lines of footer --></footer>
</body>
</html>
```

**Token breakdown:**
- Total HTML: ~2,000 tokens
- Actual content: ~200 tokens
- **90% waste**

#### The Solution: Markdown Extraction

anybrowse converts directly to clean markdown:

```markdown
# Actual Content

This is what you want...
```

**Benefits:**
- 70-90% token reduction
- Preserves semantic structure
- Removes presentation layer
- LLM-native format

#### Implementation

```python
# Using anybrowse (returns clean markdown)
import requests
from x402 import sign_payment

def extract_clean(url):
    # Returns markdown, not HTML
    response = requests.post('https://anybrowse.dev/scrape', 
                           json={'url': url})
    payment_req = response.headers['X-Payment-Requirements']
    payment = sign_payment(payment_req, private_key)
    
    response = requests.post('https://anybrowse.dev/scrape',
                           json={'url': url},
                           headers={'X-Payment': payment})
    
    return response.text  # Already markdown
```

### H2: 2. Chunk Strategically

#### The Chunking Problem

Dumping an entire article into an LLM context window:
- Wastes tokens on irrelevant sections
- May exceed context limits
- Makes retrieval imprecise

#### Best Practice: Semantic Chunking

Split content at logical boundaries:

```python
from langchain.text_splitter import RecursiveCharacterTextSplitter

def chunk_markdown(markdown, chunk_size=1000, overlap=200):
    """
    Split markdown preserving structure.
    """
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=overlap,
        separators=[
            "\n## ",      # H2 headers
            "\n### ",     # H3 headers  
            "\n\n",       # Paragraphs
            "\n",         # Lines
            " ",          # Words
            ""            # Characters
        ]
    )
    
    return splitter.create_documents([markdown])
```

**Chunking Guidelines:**

| Content Type | Chunk Size | Overlap |
|--------------|------------|---------|
| Documentation | 1000 chars | 200 |
| Articles | 1500 chars | 300 |
| Code/tutorials | 800 chars | 150 |
| FAQs | 500 chars | 100 |

### H2: 3. Preserve Metadata

#### Why Metadata Matters

Without metadata, you lose:
- Source attribution
- Content freshness
- Content hierarchy
- URL context

#### Best Practice: Frontmatter

Include YAML frontmatter in extracted content:

```markdown
---
source: https://example.com/article
title: "Article Title"
extracted_at: "2026-02-23T10:00:00Z"
author: "Author Name"
word_count: 1250
---

# Article Title

Content here...
```

#### Implementation

```python
def extract_with_metadata(url, scraper):
    markdown = scraper.scrape(url)
    
    # Extract title from first H1
    import re
    title_match = re.search(r'^# (.+)$', markdown, re.MULTILINE)
    title = title_match.group(1) if title_match else "Untitled"
    
    from datetime import datetime
    
    metadata = {
        "source": url,
        "title": title,
        "extracted_at": datetime.utcnow().isoformat(),
        "word_count": len(markdown.split())
    }
    
    # Combine with content
    frontmatter = "---\n"
    for key, value in metadata.items():
        frontmatter += f"{key}: {value}\n"
    frontmatter += "---\n\n"
    
    return frontmatter + markdown
```

### H2: 4. Handle JavaScript-Heavy Sites

#### The Dynamic Content Challenge

Modern web apps load content dynamically:
- React/Vue/Angular SPAs
- Infinite scroll
- Lazy-loaded images
- Client-side routing

#### Best Practice: Real Browser Rendering

Use a service that executes JavaScript:

```python
# anybrowse uses real Chrome browsers
# No special handling needed—JS executes automatically

content = scraper.scrape("https://react-app.example.com")
# Returns fully rendered content
```

**Signs you need JavaScript rendering:**
- Empty body tags in HTML
- Content in `<script>` tags
- Loading spinners
- "Hydration" errors

### H2: 5. Filter Noise

#### Common Noise Elements

Remove these before processing:
- Navigation menus
- Advertisements
- Cookie banners
- Newsletter signups
- Social sharing buttons
- Comments sections (usually)

#### Best Practice: Content Extraction

anybrowse automatically filters noise, but you can further refine:

```python
def clean_content(markdown):
    """Remove remaining noise from markdown."""
    import re
    
    # Remove common footer patterns
    lines = markdown.split('\n')
    cleaned = []
    
    footer_patterns = [
        r'^Share this article',
        r'^Subscribe to our newsletter',
        r'^Related articles',
        r'^Comments',
        r'^About the author'
    ]
    
    in_footer = False
    for line in lines:
        if any(re.match(pattern, line) for pattern in footer_patterns):
            in_footer = True
        
        if not in_footer:
            cleaned.append(line)
    
    return '\n'.join(cleaned)
```

### H2: 6. Optimize for Token Efficiency

#### Token Cost Math

GPT-4 pricing (as of 2026):
- Input: $0.03 per 1K tokens
- Output: $0.06 per 1K tokens

**Scenario: Processing 1000 articles**

| Approach | Tokens/Article | Total Tokens | Cost |
|----------|---------------|--------------|------|
| Raw HTML | 5,000 | 5M | $150 |
| Clean Markdown | 1,500 | 1.5M | $45 |
| Optimized | 1,000 | 1M | $30 |

**Savings: 80%**

#### Best Practices

1. **Remove code blocks** (if not needed):
```python
def remove_code_blocks(markdown):
    import re
    return re.sub(r'```[\s\S]*?```', '[CODE BLOCK]', markdown)
```

2. **Truncate long sections**:
```python
def truncate_sections(markdown, max_length=5000):
    """Keep first N characters of each major section."""
    sections = markdown.split('\n## ')
    truncated = [sections[0]]  # Keep intro
    
    for section in sections[1:]:
        if len(section) > max_length:
            section = section[:max_length] + "\n\n[Content truncated...]"
        truncated.append(section)
    
    return '\n## '.join(truncated)
```

3. **Summarize before storage**:
```python
def summarize_for_storage(content, llm):
    """Generate condensed version for vector storage."""
    prompt = f"""Summarize the following content for retrieval purposes.
    Keep key facts, entities, and concepts. Be concise.
    
    Content: {content[:10000]}
    
    Summary:"""
    
    return llm.generate(prompt)
```

### H2: 7. Handle Errors Gracefully

#### Common Failure Modes

- **404/403 errors**: Page doesn't exist or blocks scrapers
- **Timeouts**: Slow-loading content
- **Rate limiting**: Too many requests
- **Content changes**: Site redesign breaks extraction
- **Payment failures**: x402 payment issues

#### Best Practice: Robust Extraction

```python
import time
from functools import wraps

def retry_with_backoff(max_retries=3, backoff_factor=2):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            for attempt in range(max_retries):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    if attempt == max_retries - 1:
                        # Log final failure
                        logger.error(f"Failed after {max_retries} attempts: {e}")
                        return None
                    
                    wait_time = backoff_factor ** attempt
                    time.sleep(wait_time)
            return None
        return wrapper
    return decorator

class RobustScraper:
    def __init__(self, wallet_key):
        self.client = AnyBrowseClient(wallet_key)
        self.failed_urls = []
    
    @retry_with_backoff(max_retries=3)
    def scrape_safe(self, url):
        try:
            return self.client.scrape(url)
        except Exception as e:
            self.failed_urls.append({"url": url, "error": str(e)})
            raise
    
    def batch_scrape(self, urls):
        results = []
        for url in urls:
            content = self.scrape_safe(url)
            if content:
                results.append({"url": url, "content": content})
        return results
```

### H2: 8. Rate Limit and Respect Resources

#### The Ethics of Scraping

Even with permissionless x402 payments:
- Don't overwhelm target servers
- Respect robots.txt
- Cache results when possible
- Use reasonable delays

#### Best Practice: Rate Limiting

```python
import time
from collections import deque

class RateLimiter:
    def __init__(self, max_requests=10, window=60):
        self.max_requests = max_requests
        self.window = window
        self.requests = deque()
    
    def wait_if_needed(self):
        now = time.time()
        
        # Remove old requests outside window
        while self.requests and self.requests[0] < now - self.window:
            self.requests.popleft()
        
        # Wait if at limit
        if len(self.requests) >= self.max_requests:
            sleep_time = self.requests[0] - (now - self.window)
            if sleep_time > 0:
                time.sleep(sleep_time)
        
        self.requests.append(now)

# Usage
limiter = RateLimiter(max_requests=10, window=60)  # 10/minute

for url in urls:
    limiter.wait_if_needed()
    content = scraper.scrape(url)  # Costs $0.002
```

### H2: 9. Cache Strategically

#### When to Cache

Cache content when:
- Content changes infrequently
- You're processing the same URLs repeatedly
- API costs matter (even at $0.002/scrape, it adds up)

#### Best Practice: Smart Caching

```python
import hashlib
import json
from datetime import datetime, timedelta

class ContentCache:
    def __init__(self, ttl_hours=24):
        self.cache = {}
        self.ttl = timedelta(hours=ttl_hours)
    
    def get_key(self, url):
        return hashlib.md5(url.encode()).hexdigest()
    
    def get(self, url):
        key = self.get_key(url)
        if key in self.cache:
            entry = self.cache[key]
            if datetime.now() - entry['timestamp'] < self.ttl:
                return entry['content']
        return None
    
    def set(self, url, content):
        key = self.get_key(url)
        self.cache[key] = {
            'content': content,
            'timestamp': datetime.now()
        }
    
    def scrape_with_cache(self, url, scraper):
        # Check cache first
        cached = self.get(url)
        if cached:
            return cached
        
        # Fetch fresh
        content = scraper.scrape(url)
        self.set(url, content)
        return content

# Usage
cache = ContentCache(ttl_hours=24)

# First call: $0.002
content = cache.scrape_with_cache("https://example.com", scraper)

# Second call (within 24h): $0.00
content = cache.scrape_with_cache("https://example.com", scraper)
```

### H2: 10. Validate Output Quality

#### Quality Checks

Before using scraped content:

```python
def validate_extraction(markdown, url):
    """Validate scraped content quality."""
    issues = []
    
    # Check 1: Not empty
    if not markdown or len(markdown.strip()) < 100:
        issues.append("Content too short or empty")
    
    # Check 2: Has structure
    if '#' not in markdown:
        issues.append("No headers found")
    
    # Check 3: Not an error page
    error_phrases = ['404', 'not found', 'error', 'access denied']
    if any(phrase in markdown.lower() for phrase in error_phrases):
        issues.append("May be error page")
    
    # Check 4: Reasonable length
    word_count = len(markdown.split())
    if word_count < 50:
        issues.append(f"Suspiciously short ({word_count} words)")
    
    return {
        "url": url,
        "valid": len(issues) == 0,
        "issues": issues,
        "word_count": word_count
    }
```

### H2: Conclusion

Following these best practices will significantly improve your LLM applications:

**Key Takeaways:**
1. Extract markdown, not HTML (70% token savings)
2. Chunk strategically (better retrieval)
3. Preserve metadata (source attribution)
4. Use real browsers (handle JS sites)
5. Filter noise (cleaner input)
6. Optimize tokens (reduce costs)
7. Handle errors (reliability)
8. Rate limit (ethics)
9. Cache smartly (save money)
10. Validate output (quality assurance)

**Cost-Effective Implementation:**
With anybrowse at $0.002/scrape, you can:
- Scrape 500 URLs for $1
- Build production RAG pipelines for pennies
- Experiment without commitment

Start building with clean, LLM-optimized data today.

---

**Related Articles:**
- [URL to Markdown: Complete Guide](/blog/url-to-markdown-complete-guide)
- [Building RAG Pipelines with Web Scraping](/blog/rag-pipeline-tutorial)
- [10 AI Agent Use Cases](/blog/ai-agent-use-cases)

---

*Last updated: February 2026*
