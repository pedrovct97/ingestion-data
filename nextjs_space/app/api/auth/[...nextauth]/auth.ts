import NextAuth, { NextAuthOptions } from 'next-auth';
import CognitoProvider from 'next-auth/providers/cognito';
import jwt from 'jsonwebtoken';
import { getRoleForEmail } from '@/lib/auth/roles';
import { getRolePermissions } from '@/lib/auth/user-role-store';

// O Cognito devolve os grupos do usuario dentro do id_token.
// O NextAuth nao normaliza esse campo sozinho, entao decodificamos o token para
// transformar grupos Cognito em role da aplicacao.
function getCognitoGroups(idToken?: string): string[] {
  if (!idToken) return [];
  const decoded = jwt.decode(idToken) as { ['cognito:groups']?: string[] } | null;
  if (!decoded || !Array.isArray(decoded['cognito:groups'])) return [];
  return decoded['cognito:groups'];
}

// Prioridade da role:
// 1. Grupo ADMIN no Cognito.
// 2. Primeiro grupo Cognito encontrado.
// 3. Fallback por ADMIN_EMAILS no .env para bootstrapping.
function resolveRole(email?: string | null, groups: string[] = []) {
  const normalizedGroups = groups.map((group) => group.trim().toUpperCase()).filter(Boolean);
  if (normalizedGroups.includes('ADMIN')) return 'ADMIN';
  return normalizedGroups[0] || getRoleForEmail(email);
}

export const authOptions: NextAuthOptions = {
  providers: [
    CognitoProvider({
      clientId: process.env.COGNITO_CLIENT_ID || '',
      clientSecret: process.env.COGNITO_CLIENT_SECRET || '',
      issuer: process.env.COGNITO_ISSUER,
      authorization: {
        params: {
          // Forca o Cognito a pedir login novamente, evitando reutilizar uma
          // sessao antiga quando o usuario acessa localhost/EC2 em testes.
          prompt: 'login',
        },
      },
    }),
  ],
  session: {
    strategy: 'jwt',
  },
  pages: {
    signIn: '/login',
  },
  callbacks: {
    // Callback JWT roda no login e sempre que a sessao e revalidada.
    // Aqui gravamos role/permissoes dentro do token para o middleware e as
    // paginas nao precisarem consultar o Cognito a cada render.
    async jwt({ token, account, profile, trigger }) {
      if (account) {
        const groups = getCognitoGroups(account.id_token);
        const role = resolveRole(token.email || profile?.email, groups);
        token.id = profile?.sub || token.sub;
        token.role = role;
        token.permissions = await getRolePermissions(role);
      } else if (!token.role) {
        const role = getRoleForEmail(token.email);
        token.role = role;
        token.permissions = await getRolePermissions(role);
      } else if (trigger === 'update') {
        token.permissions = await getRolePermissions(String(token.role));
      }

      return token;
    },
    // Expõe id, role e permissoes no objeto session usado pelos componentes.
    async session({ session, token }) {
      if (session?.user) {
        (session.user as any).id = token.id || token.sub;
        (session.user as any).role = token.role || getRoleForEmail(session.user.email);
        (session.user as any).permissions = token.permissions;
      }
      return session;
    },
  },
};

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
