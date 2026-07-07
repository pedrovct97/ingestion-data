'use client';

import { usePathname } from 'next/navigation';
import { useSession, signOut } from 'next-auth/react';
import Link from 'next/link';
import { CloudUpload, BarChart3, LogOut, User, TableProperties, Radio, CalendarDays, Users } from 'lucide-react';
import { getAllowedRoutes } from '@/lib/auth/roles';
import { APP_BRAND_NAME } from '@/lib/app-config';

const navItems = [
  { href: '/upload', label: 'Upload', icon: CloudUpload },
  { href: '/tabelas', label: 'Tabelas', icon: TableProperties },
  { href: '/api-ingestao', label: 'API', icon: Radio },
  { href: '/usuarios', label: 'Usu\u00e1rios', icon: Users },
  { href: '/monitoramento', label: 'Monitoramento', icon: BarChart3 },
  { href: '/scheduler-calendar', label: 'Calend\u00e1rio', icon: CalendarDays },
];

// Navegacao principal. Os itens visiveis sao filtrados pelas permissoes salvas
// na sessao do usuario, mas o middleware tambem protege a rota diretamente.
export default function Navigation() {
  const pathname = usePathname();
  const { data: session } = useSession() || {};
  const role = (session?.user as any)?.role || 'USER';
  const permissions = (session?.user as any)?.permissions;
  const allowedRoutes = getAllowedRoutes(role, permissions);
  const visibleNavItems = navItems.filter((item) => allowedRoutes.includes(item.href as any));

  // Logout volta para /login; o Cognito/NextAuth cuidam de encerrar a sessao.
  const handleSignOut = () => {
    signOut({ callbackUrl: '/login' });
  };

  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-50 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center space-x-6">
            <Link href="/upload" className="flex items-center space-x-3">
              <span
                className="text-[#730401] font-bold text-2xl italic tracking-tight"
                style={{ fontFamily: 'Georgia, serif' }}
              >
                {APP_BRAND_NAME}
              </span>
              <div className="hidden sm:block h-6 w-px bg-gray-200" />
              <span className="hidden sm:block text-gray-400 text-xs font-medium uppercase tracking-wider">Pipeline</span>
            </Link>

            <div className="hidden lg:flex items-center space-x-1">
              {visibleNavItems.map((item) => {
                const Icon = item.icon;
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center space-x-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                      isActive
                        ? 'bg-[#730401] text-white shadow-sm'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-[#730401]'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>

          <div className="flex items-center space-x-3">
            <div className="hidden sm:flex items-center space-x-2 px-3 py-1.5 bg-gray-50 rounded-lg border border-gray-100">
              <User className="w-4 h-4 text-gray-400" />
              <span className="text-sm text-gray-600">{session?.user?.email}</span>
              <span className="text-[10px] font-semibold text-[#730401] bg-[#730401]/10 px-1.5 py-0.5 rounded">
                {role}
              </span>
            </div>
            <button
              onClick={handleSignOut}
              className="flex items-center space-x-2 px-3 py-2 text-gray-500 rounded-lg hover:bg-[#730401]/5 hover:text-[#730401] transition-all"
            >
              <LogOut className="w-4 h-4" />
              <span className="text-sm font-medium">Sair</span>
            </button>
          </div>
        </div>
      </div>

      {/* Mobile nav */}
      <div className="lg:hidden border-t border-gray-100 px-2 pb-2 flex space-x-1 overflow-x-auto">
        {visibleNavItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center space-x-1.5 px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
                isActive
                  ? 'bg-[#730401] text-white'
                  : 'text-gray-500 hover:bg-gray-100 hover:text-[#730401]'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
