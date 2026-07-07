import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { getRoleForEmail, hasRouteAccess } from '@/lib/auth/roles';

const PROTECTED_ROUTES = [
  '/upload',
  '/historico',
  '/monitoramento',
  '/tabelas',
  '/api-ingestao',
  '/usuarios',
  '/scheduler-calendar',
  '/configuracoes',
];

// Middleware executa antes das paginas protegidas.
// Ele garante duas coisas:
// 1. Usuario sem sessao e enviado para /login.
// 2. Usuario autenticado mas sem permissao para a rota e enviado para /upload.
// A regra fina de permissao fica centralizada em lib/auth/roles.ts.
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/historico' || pathname.startsWith('/historico/')) {
    const url = req.nextUrl.clone();
    url.pathname = '/monitoramento';
    url.search = '';
    return NextResponse.redirect(url);
  }
  if (pathname === '/configuracoes' || pathname.startsWith('/configuracoes/')) {
    const url = req.nextUrl.clone();
    url.pathname = '/tabelas';
    url.search = '';
    return NextResponse.redirect(url);
  }

  const isProtectedRoute = PROTECTED_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );

  if (!isProtectedRoute) {
    return NextResponse.next();
  }

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  const role = String(token.role || getRoleForEmail(token.email));
  const permissions = token.permissions as any;
  if (!hasRouteAccess(pathname, role, permissions)) {
    const uploadUrl = req.nextUrl.clone();
    uploadUrl.pathname = '/upload';
    uploadUrl.search = '';
    return NextResponse.redirect(uploadUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/upload/:path*',
    '/historico/:path*',
    '/monitoramento/:path*',
    '/tabelas/:path*',
    '/api-ingestao/:path*',
    '/usuarios/:path*',
    '/scheduler-calendar/:path*',
    '/configuracoes/:path*',
  ],
};
