export type UserRole = string;

export type AppRoute =
  | '/upload'
  | '/monitoramento'
  | '/tabelas'
  | '/api-ingestao'
  | '/usuarios'
  | '/scheduler-calendar';

export interface RolePermissions {
  pages: AppRoute[];
  canCreateTables: boolean;
  canRunApiActions: boolean;
}

// Lista canonica das paginas protegidas do sistema. Toda regra de menu,
// middleware e administracao de roles deve usar estes caminhos para evitar
// divergencia entre tela visivel e rota acessivel.
export const APP_PAGES: Array<{ route: AppRoute; label: string }> = [
  { route: '/upload', label: 'Envio de Arquivos' },
  { route: '/monitoramento', label: 'Monitoramento' },
  { route: '/tabelas', label: 'Tabelas' },
  { route: '/api-ingestao', label: 'API' },
  { route: '/usuarios', label: 'Usuários' },
  { route: '/scheduler-calendar', label: 'Calendário' },
];

// Permissoes padrao criadas no Cognito quando os grupos ainda nao existem.
// ADMIN recebe acesso total; USER fica restrito ao fluxo operacional basico.
export const DEFAULT_ROLE_PERMISSIONS: Record<string, RolePermissions> = {
  ADMIN: {
    pages: APP_PAGES.map((page) => page.route),
    canCreateTables: true,
    canRunApiActions: true,
  },
  USER: {
    pages: ['/upload', '/monitoramento'],
    canCreateTables: false,
    canRunApiActions: false,
  },
};

const ROUTE_ALIASES: Partial<Record<string, AppRoute>> = {
  '/historico': '/monitoramento',
  '/configuracoes': '/tabelas',
};

function parseEmailList(value?: string): string[] {
  return (value || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function normalizeRoleName(role?: string | null): string {
  return (role || 'USER').trim().toUpperCase().replace(/\s+/g, '_') || 'USER';
}

// Remove permissoes invalidas recebidas da UI/Cognito. Isso protege contra
// rotas digitadas manualmente e deixa o payload salvo no grupo sempre limpo.
export function normalizePermissions(input?: Partial<RolePermissions> | null): RolePermissions {
  const pages = new Set<AppRoute>();
  const validRoutes = new Set(APP_PAGES.map((page) => page.route));

  for (const route of input?.pages || []) {
    if (validRoutes.has(route)) {
      pages.add(route);
    }
  }

  return {
    pages: Array.from(pages),
    canCreateTables: Boolean(input?.canCreateTables),
    canRunApiActions: input?.canRunApiActions ?? pages.has('/api-ingestao'),
  };
}

// Fallback de primeiro acesso: antes de existir gestao completa por Cognito,
// ADMIN_EMAILS permite liberar um administrador inicial sem tabela de usuarios.
export function getRoleForEmail(email?: string | null): string {
  if (!email) return 'USER';

  const normalizedEmail = email.toLowerCase();
  const adminEmails = new Set(parseEmailList(process.env.ADMIN_EMAILS));

  return adminEmails.has(normalizedEmail) ? 'ADMIN' : 'USER';
}

export function getDefaultPermissionsForRole(role?: string | null): RolePermissions {
  return DEFAULT_ROLE_PERMISSIONS[normalizeRoleName(role)] || DEFAULT_ROLE_PERMISSIONS.USER;
}

export function getAllowedRoutes(
  role?: string | null,
  permissions?: Partial<RolePermissions> | null
): AppRoute[] {
  return Array.isArray(permissions?.pages)
    ? normalizePermissions(permissions).pages
    : getDefaultPermissionsForRole(role).pages;
}

export function hasRouteAccess(
  pathname: string,
  role?: string | null,
  permissions?: Partial<RolePermissions> | null
): boolean {
  const allowedRoutes = getAllowedRoutes(role, permissions);
  const canonicalPath = ROUTE_ALIASES[pathname] || pathname;
  return allowedRoutes.some((route) => canonicalPath === route || canonicalPath.startsWith(`${route}/`));
}

export function canCreateTables(
  role?: string | null,
  permissions?: Partial<RolePermissions> | null
): boolean {
  return permissions?.canCreateTables ?? getDefaultPermissionsForRole(role).canCreateTables;
}

export function canRunApiActions(
  role?: string | null,
  permissions?: Partial<RolePermissions> | null
): boolean {
  return normalizePermissions(permissions || getDefaultPermissionsForRole(role)).canRunApiActions;
}

export function isAdminRole(role?: string | null): boolean {
  return normalizeRoleName(role) === 'ADMIN';
}
