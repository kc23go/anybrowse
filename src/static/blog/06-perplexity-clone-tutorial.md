# SEO Blog Post 6: Build a Perplexity Clone with Web Scraping

**Target Keyword:** "build perplexity clone"  
**Secondary Keywords:** "ai search engine", "rag search", "web search ai", "perplexity alternative"  
**Word Count:** ~2,900 words  
**Content Type:** Project Tutorial

---

## URL Slug
`/blog/build-perplexity-clone-web-scraping`

## Meta Title (60 chars)
Build a Perplexity Clone with Web Scraping | Tutorial

## Meta Description (155 chars)
Build your own Perplexity-style AI search engine. Step-by-step tutorial with code. x402 micropayments. Real-time web access. $0.002/scrape.

---

## H1: Build Your Own Perplexity Clone with Web Scraping and LLMs

### Introduction

Perplexity AI revolutionized search by combining traditional web search with LLM-powered synthesis. But what if you could build your own version—customized to your needs, without vendor lock-in, and with full control over the data sources?

In this tutorial, you'll build a Perplexity-style AI search engine using:
- **Web search APIs** (Serper, Brave, or DuckDuckGo)
- **anybrowse** for content extraction ($0.002/scrape)
- **OpenAI/Anthropic** for synthesis
- **x402 micropayments** for permissionless scraping

By the end, you'll have a working system that can answer questions with cited, up-to-date information from the web.

### H2: Architecture Overview

```
User Query
    ↓
Search API (find relevant URLs)
    ↓
Content Extraction (anybrowse - $0.002/scrape)
    ↓
Chunk & Vectorize (embeddings)
    ↓
Retrieve Relevant Chunks
    ↓
LLM Synthesis (with citations)
    ↓
Formatted Answer with Sources
```

### H2: Prerequisites

**Accounts & Keys:**
- OpenAI API key (for embeddings and synthesis)
- Search API key (Serper.dev recommended—1,000 free searches)
- Wallet with USDC on Base network (for x402 payments)

**Python Environment:**
```bash
python -m venv perplexity-clone
source perplexity-clone/bin/activate

pip install openai langchain chromadb requests
pip install x402-python  # For micropayments
```

**Wallet Setup:**
```bash
# Get USDC on Base network
# You need ~$1 for testing (500 scrapes)
# PayTo address: 0x8D76E8FB38541d70dF74b14660c39b4c5d737088
```

### H2: Step 1: Search Integration

First, we need to find relevant URLs for a given query.

```python
import requests
import os

class WebSearch:
    """Search the web using Serper.dev (Google Search API)"""
    
    def __init__(self, api_key=None):
        self.api_key = api_key or os.getenv('SERPER_API_KEY')
        self.endpoint = "https://google.serper.dev/search"
    
    def search(self, query, num_results=5):
        """Search and return top URLs."""
        headers = {
            'X-API-KEY': self.api_key,
            'Content-Type': 'application/json'
        }
        
        payload = {
            'q': query,
            'num': num_results
        }
        
        response = requests.post(self.endpoint, 
                               headers=headers, 
                               json=payload)
        
        data = response.json()
        
        # Extract organic results
        urls = []
        for result in data.get('organic', []):
            urls.append({
                'title': result['title'],
                'url': result['link'],
                'snippet': result.get('snippet', '')
            })
        
        return urls

# Test
search = WebSearch()
results = search.search("latest AI developments 2026")
for r in results:
    print(f"{r['title']}: {r['url']}")
```

**Alternative: Brave Search API**
```python
class BraveSearch:
    def __init__(self, api_key=None):
        self.api_key = api_key or os.getenv('BRAVE_API_KEY')
    
    def search(self, query, num_results=5):
        headers = {'X-Subscription-Token': self.api_key}
        params = {'q': query, 'count': num_results}
        
        response = requests.get(
            'https://api.search.brave.com/res/v1/web/search',
            headers=headers,
            params=params
        )
        
        data = response.json()
        return [{'title': r['title'], 'url': r['url']} 
                for r in data.get('web', {}).get('results', [])]
```

### H2: Step 2: Content Extraction with anybrowse

Now we extract full content from each search result.

```python
from x402 import sign_payment

class ContentExtractor:
    """Extract article content using anybrowse with x402 payments"""
    
    BASE_URL = "https://anybrowse.dev"
    PAYTO_ADDRESS = "0x8D76E8FB38541d70dF74b14660c39b4c5d737088"
    
    def __init__(self, private_key):
        self.private_key = private_key
    
    def extract(self, url):
        """
        Extract URL content to markdown.
        Cost: $0.002 per extraction (paid in USDC on Base)
        """
        endpoint = f"{self.BASE_URL}/scrape"
        
        # Step 1: Get payment requirements
        response = requests.post(endpoint, json={'url': url})
        
        if response.status_code != 402:
            print(f"Unexpected status: {response.status_code}")
            return None
        
        # Step 2: Sign payment authorization
        payment_req = response.headers['X-Payment-Requirements']
        payment = sign_payment(payment_req, self.private_key)
        
        # Step 3: Resubmit with payment
        response = requests.post(
            endpoint,
            json={'url': url},
            headers={'X-Payment': payment}
        )
        
        if response.status_code == 200:
            return {
                'url': url,
                'content': response.text,
                'cost': 0.002  # Track costs
            }
        else:
            print(f"Extraction failed: {response.status_code}")
            return None
    
    def extract_batch(self, urls):
        """Extract multiple URLs."""
        results = []
        total_cost = 0
        
        for url_info in urls:
            url = url_info['url'] if isinstance(url_info, dict) else url_info
            print(f"Extracting: {url}")
            
            result = self.extract(url)
            if result:
                results.append(result)
                total_cost += result['cost']
            
        print(f"\nTotal extraction cost: ${total_cost:.3f}")
        return results
```

### H2: Step 3: Document Processing

Chunk and embed the extracted content.

```python
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain.embeddings import OpenAIEmbeddings
from langchain.vectorstores import Chroma
import hashlib

class DocumentProcessor:
    """Process extracted content for retrieval"""
    
    def __init__(self):
        self.embeddings = OpenAIEmbeddings()
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=1000,
            chunk_overlap=200,
            separators=["\n## ", "\n### ", "\n\n", "\n", " ", ""]
        )
    
    def process_extractions(self, extractions):
        """Convert extractions to vector store."""
        documents = []
        
        for extraction in extractions:
            # Split into chunks
            chunks = self.text_splitter.split_text(extraction['content'])
            
            # Create documents with metadata
            for i, chunk in enumerate(chunks):
                documents.append({
                    'content': chunk,
                    'metadata': {
                        'source': extraction['url'],
                        'chunk_index': i,
                        'doc_id': hashlib.md5(extraction['url'].encode()).hexdigest()
                    }
                })
        
        return documents
    
    def create_vector_store(self, documents):
        """Create ChromaDB vector store."""
        texts = [doc['content'] for doc in documents]
        metadatas = [doc['metadata'] for doc in documents]
        
        vectorstore = Chroma.from_texts(
            texts,
            self.embeddings,
            metadatas=metadatas,
            persist_directory="./perplexity_db"
        )
        
        return vectorstore
```

### H2: Step 4: Answer Synthesis

Generate answers using retrieved context.

```python
import openai

class AnswerSynthesizer:
    """Generate answers with citations"""
    
    def __init__(self, api_key=None):
        openai.api_key = api_key or os.getenv('OPENAI_API_KEY')
    
    def synthesize(self, query, retrieved_chunks):
        """Generate answer with citations."""
        
        # Build context from chunks
        context_parts = []
        for i, chunk in enumerate(retrieved_chunks):
            context_parts.append(
                f"[{i+1}] Source: {chunk.metadata['source']}\n"
                f"{chunk.page_content}\n"
            )
        
        context = "\n---\n".join(context_parts)
        
        # Create prompt
        prompt = f"""Answer the following question using the provided context.
        Cite your sources using [1], [2], etc. If the context doesn't contain 
        the answer, say so clearly.
        
        Question: {query}
        
        Context:
        {context}
        
        Provide a comprehensive answer with inline citations:"""
        
        # Generate answer
        response = openai.ChatCompletion.create(
            model="gpt-4",
            messages=[
                {"role": "system", "content": "You are a helpful research assistant. Answer questions based on the provided context with proper citations."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.3
        )
        
        answer = response.choices[0].message.content
        
        # Extract unique sources for references
        sources = list(set([c.metadata['source'] for c in retrieved_chunks]))
        
        return {
            'answer': answer,
            'sources': sources
        }
```

### H2: Step 5: Putting It All Together

```python
class PerplexityClone:
    """Complete Perplexity-style search engine"""
    
    def __init__(self, wallet_key, search_api_key, openai_key):
        self.search = WebSearch(search_api_key)
        self.extractor = ContentExtractor(wallet_key)
        self.processor = DocumentProcessor()
        self.synthesizer = AnswerSynthesizer(openai_key)
        self.vectorstore = None
    
    def query(self, question, num_results=5):
        """
        Answer a question using web search + synthesis.
        
        Cost breakdown:
        - Search: ~$0.001 (or free with Serper trial)
        - Extraction: $0.002 × num_results
        - Embedding: ~$0.0001 per 1K tokens
        - Synthesis: ~$0.01-0.02
        """
        print(f"🔍 Searching for: {question}")
        
        # 1. Search for relevant URLs
        search_results = self.search.search(question, num_results)
        print(f"Found {len(search_results)} sources")
        
        # 2. Extract content from URLs
        print("\n📄 Extracting content...")
        extractions = self.extractor.extract_batch(search_results)
        print(f"Successfully extracted {len(extractions)} pages")
        
        if not extractions:
            return {"error": "Failed to extract content from search results"}
        
        # 3. Process and vectorize
        print("\n🧠 Processing content...")
        documents = self.processor.process_extractions(extractions)
        self.vectorstore = self.processor.create_vector_store(documents)
        
        # 4. Retrieve relevant chunks
        print("\n🔎 Retrieving relevant passages...")
        retrieved = self.vectorstore.similarity_search(question, k=5)
        
        # 5. Synthesize answer
        print("\n✍️  Synthesizing answer...")
        result = self.synthesizer.synthesize(question, retrieved)
        
        return result
    
    def format_output(self, result):
        """Format the answer for display."""
        print("\n" + "="*60)
        print("ANSWER")
        print("="*60)
        print(result['answer'])
        
        print("\n" + "="*60)
        print("SOURCES")
        print("="*60)
        for i, source in enumerate(result['sources'], 1):
            print(f"[{i}] {source}")

# Usage
if __name__ == "__main__":
    import os
    
    # Initialize
    app = PerplexityClone(
        wallet_key=os.getenv('WALLET_PRIVATE_KEY'),
        search_api_key=os.getenv('SERPER_API_KEY'),
        openai_key=os.getenv('OPENAI_API_KEY')
    )
    
    # Query
    question = "What are the latest developments in quantum computing?"
    result = app.query(question, num_results=5)
    
    # Display
    app.format_output(result)
```

### H2: Step 6: Enhancing the System

#### Add Follow-up Questions

```python
def generate_followups(self, question, answer):
    """Generate suggested follow-up questions."""
    prompt = f"""Based on this question and answer, generate 3 relevant 
    follow-up questions someone might ask:
    
    Original: {question}
    Answer: {answer[:500]}...
    
    Follow-ups:"""
    
    response = openai.ChatCompletion.create(
        model="gpt-4",
        messages=[{"role": "user", "content": prompt}]
    )
    
    return response.choices[0].message.content.split('\n')
```

#### Add Source Preview Cards

```python
def get_source_previews(self, urls):
    """Generate preview cards for sources."""
    previews = []
    
    for url in urls:
        extraction = self.extractor.extract(url)
        if extraction:
            # Extract title and first paragraph
            lines = extraction['content'].split('\n')
            title = lines[0].replace('# ', '') if lines[0].startswith('# ') else url
            preview = ' '.join(lines[1:3])[:200] + "..."
            
            previews.append({
                'title': title,
                'url': url,
                'preview': preview
            })
    
    return previews
```

### H2: Cost Analysis

**Per Query Cost Breakdown:**

| Component | Cost | Notes |
|-----------|------|-------|
| Web Search | $0.001 | Serper.dev (or free tier) |
| Content Extraction (5 sources) | $0.010 | $0.002 × 5 |
| Embeddings | $0.001 | ~3K tokens |
| LLM Synthesis | $0.015 | GPT-4, ~500 tokens |
| **Total** | **~$0.027** | Per query |

**Scaling:**
- 100 queries/day = $2.70/day = $81/month
- 1,000 queries/day = $27/day = $810/month

Compare to Perplexity Pro at $20/month—you're paying for full control and customization.

### H2: Deployment Options

#### Option 1: CLI Tool

```python
# simple_cli.py
import argparse

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('query', help='Your question')
    parser.add_argument('--sources', type=int, default=5)
    args = parser.parse_args()
    
    app = PerplexityClone(...)
    result = app.query(args.query, args.sources)
    app.format_output(result)
```

#### Option 2: Web API (FastAPI)

```python
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
perplexity = PerplexityClone(...)

class QueryRequest(BaseModel):
    question: str
    num_sources: int = 5

@app.post("/query")
async def query(request: QueryRequest):
    result = perplexity.query(request.question, request.num_sources)
    return result
```

#### Option 3: MCP Server Integration

```json
// Integrate with Claude Desktop
{
  "mcpServers": {
    "perplexity-clone": {
      "command": "python",
      "args": ["-m", "perplexity_server"]
    }
  }
}
```

### H2: Conclusion

You've built a functioning Perplexity clone that:
- ✅ Searches the web in real-time
- ✅ Extracts content with x402 micropayments
- ✅ Synthesizes answers with citations
- ✅ Costs ~$0.03 per query
- ✅ Requires no API key subscriptions for scraping

**Next Steps:**
1. Add caching to reduce costs
2. Implement streaming responses
3. Add conversation memory
4. Deploy as a web service
5. Add more data sources (PDFs, databases)

**The x402 Advantage:**
Traditional scraping APIs require subscriptions and API keys. With anybrowse, you pay only for what you use—perfect for variable query volumes and experimental projects.

Start asking questions. The web is now your knowledge base.

---

**Related Articles:**
- [Building RAG Pipelines with Web Scraping](/blog/rag-pipeline-tutorial)
- [URL to Markdown: Complete Guide](/blog/url-to-markdown-complete-guide)
- [10 AI Agent Use Cases](/blog/ai-agent-use-cases)

---

*Last updated: February 2026*
