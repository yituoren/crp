<script setup lang="ts">
import { marked, type Tokens } from 'marked';
// The manual is the repository's docs/user-manual.md, bundled at build time so the page always matches the deployed version
import source from '../../../docs/user-manual.md?raw';

/** Headings get ids (h2/h3) so the table of contents can link to them; tables scroll sideways on narrow screens */
const toc: { id: string; text: string; level: number }[] = [];
let n = 0;
const renderer = new marked.Renderer();
renderer.heading = function ({ tokens, depth }: Tokens.Heading) {
  const html = this.parser.parseInline(tokens);
  if (depth === 1) return `<h1>${html}</h1>`;
  const id = `m-${++n}`;
  if (depth <= 3) toc.push({ id, text: html.replace(/<[^>]+>/g, ''), level: depth });
  return `<h${depth} id="${id}">${html}</h${depth}>`;
};
const baseTable = renderer.table.bind(renderer);
renderer.table = (t: Tokens.Table) => `<div class="manual-table">${baseTable(t)}</div>`;
const html = marked.parse(source, { renderer, async: false }) as string;

function jump(id: string) { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
</script>

<template>
  <div class="manual">
    <nav class="manual-toc card">
      <div class="manual-toc-title">目录</div>
      <a v-for="h in toc" :key="h.id" href="#" :class="'manual-toc-' + h.level" @click.prevent="jump(h.id)">{{ h.text }}</a>
    </nav>
    <!-- content is the repository's own manual, not user input -->
    <article class="manual-body card" v-html="html"></article>
  </div>
</template>
