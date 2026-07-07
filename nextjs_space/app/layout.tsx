import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

// Layout raiz do Next.js.
// Tudo que precisa existir em todas as telas entra aqui: fonte global,
// estilos globais e providers de contexto usados pelo app inteiro.
const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'ingestion-app | AWS Data Pipeline',
  description: 'Ferramenta interna para upload e monitoramento de pipelines de dados',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body className={inter.className}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
