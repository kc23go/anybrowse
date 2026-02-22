# anybrowse.dev Website Deployment Guide

## Overview

This folder contains the anybrowse.dev website files:
- `index.html` - Landing page with hero, features, use cases, and CTAs
- `docs.html` - Complete documentation with SDK examples
- `blog.html` - Announcement blog post with Twitter thread content

## Quick Deployment

### Option 1: Vercel (Recommended)

1. **Install Vercel CLI:**
   ```bash
   npm i -g vercel
   ```

2. **Deploy:**
   ```bash
   cd /home/openclaw/.openclaw/workspace/anybrowse/website
   vercel --prod
   ```

3. **Configure custom domain:**
   - Go to Vercel dashboard → Project Settings → Domains
   - Add `anybrowse.dev`
   - Update DNS records at your registrar to point to Vercel

### Option 2: Netlify

1. **Install Netlify CLI:**
   ```bash
   npm i -g netlify-cli
   ```

2. **Deploy:**
   ```bash
   cd /home/openclaw/.openclaw/workspace/anybrowse/website
   netlify deploy --prod --dir=.
   ```

3. **Configure custom domain:**
   - Go to Netlify dashboard → Site settings → Domain management
   - Add `anybrowse.dev`
   - Configure DNS as instructed

### Option 3: GitHub Pages

1. **Push to GitHub:**
   ```bash
   cd /home/openclaw/.openclaw/workspace/anybrowse/website
   git init
   git add .
   git commit -m "Initial website commit"
   git branch -M main
   git remote add origin https://github.com/anybrowse/anybrowse.github.io.git
   git push -u origin main
   ```

2. **Enable GitHub Pages:**
   - Go to repository Settings → Pages
   - Source: Deploy from a branch → main
   - Folder: / (root)

3. **Configure custom domain:**
   - Add `anybrowse.dev` in the Custom domain field
   - Create a `CNAME` file with `anybrowse.dev` inside
   - Update DNS with the provided IP addresses

### Option 4: Cloudflare Pages

1. **Push to Git:**
   ```bash
   cd /home/openclaw/.openclaw/workspace/anybrowse/website
   git init
   git add .
   git commit -m "Initial website commit"
   git push origin main
   ```

2. **Connect to Cloudflare Pages:**
   - Go to Cloudflare Dashboard → Pages
   - Create a project → Connect to Git
   - Select your repository
   - Build settings: Leave empty (static site)
   - Deploy

3. **Custom domain:**
   - Add `anybrowse.dev` in the Custom domains section
   - Cloudflare will auto-configure DNS if the domain is on Cloudflare

## DNS Configuration

Add these DNS records at your domain registrar:

### For Vercel:
```
Type: A
Name: @
Value: 76.76.21.21

Type: CNAME
Name: www
Value: cname.vercel-dns.com
```

### For Netlify:
```
Type: CNAME
Name: @
Value: [your-site-name].netlify.app
```

### For GitHub Pages:
```
Type: A
Name: @
Value: 185.199.108.153
Value: 185.199.109.153
Value: 185.199.110.153
Value: 185.199.111.153

Type: CNAME
Name: www
Value: anybrowse.github.io
```

## Files Overview

### index.html (Landing Page)
- **Hero:** "Let Your Agents Browse Agents" headline with CTAs
- **Features:** 3 key features (MCP Registry, Agent Discovery, Direct Networking)
- **Use Cases:** Developers, Enterprise, Researchers, Tool Builders
- **How It Works:** 3-step process visualization
- **SDK Preview:** Code examples
- **CTA Section:** Final call to action
- **Footer:** Links and social

### docs.html (Documentation)
- Sidebar navigation with sections
- Installation guides for Python, TypeScript, Rust, Go
- Quick start tutorial with code examples
- MCP protocol explanation
- Registry and discovery documentation
- Direct networking concepts
- Complete SDK reference tables
- FAQ and contact information

### blog.html (News/Blog)
- Announcement post: "Introducing anybrowse"
- Twitter thread formatted as 7 sequential tweets
- Embedded CTAs and links

## Content Sources

All content derived from:
- `/home/openclaw/.openclaw/workspace/anybrowse/landing-page-copy.md` → index.html
- `/home/openclaw/.openclaw/workspace/anybrowse/one-pager-pdf-content.md` → docs.html
- `/home/openclaw/.openclaw/workspace/anybrowse/twitter-thread.md` → blog.html

## SEO Configuration

Meta tags already configured in all pages:
- Title optimized for search
- Description with keywords
- Keywords: MCP, Model Context Protocol, AI agents, agent registry, etc.

## Future Updates

To update the website:
1. Edit the relevant HTML file(s)
2. Commit and push changes
3. Deployment will auto-update (if using Git-based hosting)
4. Or re-run the deploy command for CLI-based hosting

## Support

For deployment issues:
- Vercel: https://vercel.com/docs
- Netlify: https://docs.netlify.com
- GitHub Pages: https://docs.github.com/en/pages
- Cloudflare Pages: https://developers.cloudflare.com/pages