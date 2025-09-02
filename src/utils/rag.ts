import { Pinecone } from '@pinecone-database/pinecone';
import { OpenAIEmbeddings } from '@langchain/openai';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

import { TRINKS_DOCS } from '../constants'; // Assumindo que criaremos um arquivo de constantes com o conteúdo da doc

// Inicializa o cliente Pinecone
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY!,
});

const index = pinecone.Index(process.env.PINECONE_INDEX_NAME!);

// Função para vetorizar e upsert documentos
async function vectorizeDocs() {
  const embeddings = new OpenAIEmbeddings();
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });

  const docs = await splitter.splitText(TRINKS_DOCS);

  const vectors = await embeddings.embedDocuments(docs);

  const upserts = vectors.map((vector, i) => ({
    id: `doc-${i}`,
    values: vector,
    metadata: { text: docs[i] },
  }));

  await index.upsert(upserts);
}

export async function queryRag(query: string) {
  const embeddings = new OpenAIEmbeddings();
  const queryEmbedding = await embeddings.embedQuery(query);

  const results = await index.query({
    vector: queryEmbedding,
    topK: 3,
    includeMetadata: true,
  });

  return results.matches.map(match => match.metadata?.text).join('\n');
}