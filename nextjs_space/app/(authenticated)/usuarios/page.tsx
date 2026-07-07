'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Edit3,
  KeyRound,
  Loader2,
  Plus,
  Save,
  Shield,
  UserPlus,
  Users,
  X,
} from 'lucide-react';

interface AppPage {
  route: string;
  label: string;
}

interface RolePermissions {
  pages: string[];
  canCreateTables: boolean;
  canRunApiActions: boolean;
}

interface ManagedRole {
  name: string;
  description: string | null;
  permissions: RolePermissions;
}

interface ManagedUser {
  id: string;
  name: string | null;
  email: string;
  role: string;
  createdAt: string;
}

type Mode = 'list' | 'create' | 'edit';

const emptyUserForm = {
  id: '',
  name: '',
  email: '',
  password: '',
  role: 'USER',
};

const emptyRoleForm = {
  name: '',
  description: '',
  pages: ['/upload', '/monitoramento'] as string[],
  canCreateTables: false,
  canRunApiActions: false,
};

// Tela administrativa de Cognito.
// Usuarios sao criados no User Pool; roles sao grupos Cognito com permissoes
// salvas em JSON na Description do grupo.
export default function UsuariosPage() {
  const [activeTab, setActiveTab] = useState<'users' | 'roles'>('users');
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [roles, setRoles] = useState<ManagedRole[]>([]);
  const [pages, setPages] = useState<AppPage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [userMode, setUserMode] = useState<Mode>('list');
  const [roleMode, setRoleMode] = useState<Mode>('list');
  const [userForm, setUserForm] = useState(emptyUserForm);
  const [roleForm, setRoleForm] = useState(emptyRoleForm);

  const roleOptions = useMemo(() => roles.map((role) => role.name), [roles]);
  const existingRoleNames = useMemo(() => new Set(roleOptions), [roleOptions]);

  // Carrega usuarios, roles e lista de paginas protegidas em uma unica chamada.
  const loadData = async () => {
    setIsLoading(true);
    setError('');
    try {
      const response = await fetch('/excel_ingestion/users');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Erro ao carregar usuários');
      setUsers(data.users || []);
      setRoles(data.roles || []);
      setPages(data.pages || []);
    } catch (err: any) {
      setError(err?.message || 'Erro ao carregar usuários');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const showSuccess = (message: string) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 3500);
  };

  const resetPanels = () => {
    setUserMode('list');
    setRoleMode('list');
    setUserForm(emptyUserForm);
    setRoleForm(emptyRoleForm);
  };

  // Abre painel lateral/formulario para criar usuario.
  const openNewUser = () => {
    setActiveTab('users');
    setUserForm({ ...emptyUserForm, role: roleOptions.includes('USER') ? 'USER' : roleOptions[0] || 'USER' });
    setUserMode('create');
  };

  // Editar usuario permite alterar nome, email, senha opcional e role.
  const openEditUser = (user: ManagedUser) => {
    setActiveTab('users');
    setUserForm({
      id: user.id,
      name: user.name || '',
      email: user.email,
      password: '',
      role: user.role,
    });
    setUserMode('edit');
  };

  const openNewRole = () => {
    setActiveTab('roles');
    setRoleForm(emptyRoleForm);
    setRoleMode('create');
  };

  const openEditRole = (role: ManagedRole) => {
    setActiveTab('roles');
    setRoleForm({
      name: role.name,
      description: role.description || '',
      pages: role.permissions.pages || [],
      canCreateTables: role.permissions.canCreateTables,
      canRunApiActions: role.permissions.canRunApiActions,
    });
    setRoleMode('edit');
  };

  const saveUser = async () => {
    setError('');
    setIsSaving(true);
    try {
      const method = userMode === 'create' ? 'POST' : 'PATCH';
      const response = await fetch('/excel_ingestion/users', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: userForm.id,
          name: userForm.name,
          email: userForm.email,
          password: userForm.password || undefined,
          role: userForm.role,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Erro ao salvar usuário');

      showSuccess(userMode === 'create' ? 'Usuário criado com sucesso' : 'Usuário atualizado com sucesso');
      resetPanels();
      await loadData();
    } catch (err: any) {
      setError(err?.message || 'Erro ao salvar usuário');
    } finally {
      setIsSaving(false);
    }
  };

  // Cada checkbox de pagina altera o array pages da role.
  const toggleRolePage = (route: string) => {
    setRoleForm((prev) => {
      const currentPages = new Set(prev.pages);
      if (currentPages.has(route)) currentPages.delete(route);
      else currentPages.add(route);
      return { ...prev, pages: Array.from(currentPages) };
    });
  };

  // Salva role como grupo Cognito. Se o nome ja existe, usa PATCH; caso
  // contrario, cria novo grupo.
  const saveRole = async () => {
    setError('');
    setIsSaving(true);
    try {
      const normalizedName = roleForm.name.toUpperCase().replace(/\s+/g, '_');
      const method = roleMode === 'edit' || existingRoleNames.has(normalizedName) ? 'PATCH' : 'POST';
      const response = await fetch('/excel_ingestion/users', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'role',
          name: roleForm.name,
          description: roleForm.description,
          pages: roleForm.pages,
          canCreateTables: roleForm.canCreateTables,
          canRunApiActions: roleForm.canRunApiActions,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Erro ao salvar role');

      showSuccess('Role salva com sucesso');
      resetPanels();
      await loadData();
    } catch (err: any) {
      setError(err?.message || 'Erro ao salvar role');
    } finally {
      setIsSaving(false);
    }
  };

  const currentPanelOpen = activeTab === 'users' ? userMode !== 'list' : roleMode !== 'list';

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-[#730401] mb-1">Gerenciamento de Usuários</h1>
          <p className="text-gray-500">
            Usuários em lista compacta, roles por permissão de aba e criação de tabela.
          </p>
        </div>
        <button
          onClick={activeTab === 'users' ? openNewUser : openNewRole}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#730401] text-white rounded-lg text-sm font-medium hover:bg-[#5f0301]"
        >
          <Plus className="w-4 h-4" />
          {activeTab === 'users' ? 'Novo usuário' : 'Nova role'}
        </button>
      </div>

      <div className="flex flex-col lg:flex-row gap-5">
        <div className="flex-1 min-w-0 space-y-4">
          <div className="inline-flex bg-white border border-gray-200 rounded-lg p-1 shadow-sm">
            <button
              onClick={() => {
                setActiveTab('users');
                resetPanels();
              }}
              className={`px-4 py-2 rounded-md text-sm font-medium flex items-center gap-2 ${
                activeTab === 'users' ? 'bg-[#730401] text-white' : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              <Users className="w-4 h-4" />
              Usuários
            </button>
            <button
              onClick={() => {
                setActiveTab('roles');
                resetPanels();
              }}
              className={`px-4 py-2 rounded-md text-sm font-medium flex items-center gap-2 ${
                activeTab === 'roles' ? 'bg-[#730401] text-white' : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              <Shield className="w-4 h-4" />
              Roles
            </button>
          </div>

          {error && (
            <div className="p-3 bg-[#730401]/5 border border-[#730401]/20 rounded-lg flex items-start space-x-2">
              <AlertCircle className="w-5 h-5 text-[#730401] flex-shrink-0 mt-0.5" />
              <p className="text-sm text-[#730401]">{error}</p>
            </div>
          )}

          {success && (
            <div className="p-3 bg-green-50 border border-green-200 rounded-lg flex items-start space-x-2">
              <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-green-700">{success}</p>
            </div>
          )}

          {isLoading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="w-8 h-8 text-[#730401] animate-spin" />
            </div>
          ) : activeTab === 'users' ? (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="grid grid-cols-[1.5fr_1.4fr_120px_92px] gap-3 px-4 py-2.5 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                <span>Usuário</span>
                <span>E-mail</span>
                <span>Role</span>
                <span className="text-right">Acao</span>
              </div>
              <div className="divide-y divide-gray-100">
                {users.map((user) => (
                  <div
                    key={user.id}
                    className="grid grid-cols-[1.5fr_1.4fr_120px_92px] gap-3 px-4 py-3 items-center hover:bg-gray-50/70"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">
                        {user.name || user.email}
                      </p>
                      <p className="text-xs text-gray-400">
                        {new Date(user.createdAt).toLocaleDateString('pt-BR')}
                      </p>
                    </div>
                    <p className="text-sm text-gray-600 truncate">{user.email}</p>
                    <span className="w-fit px-2.5 py-1 rounded-md bg-[#730401]/10 text-[#730401] text-xs font-semibold">
                      {user.role}
                    </span>
                    <button
                      onClick={() => openEditUser(user)}
                      className="justify-self-end inline-flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 rounded-lg text-xs font-medium text-gray-600 hover:text-[#730401] hover:border-[#730401]/30"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      Editar
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="grid grid-cols-[1fr_1.6fr_120px_92px] gap-3 px-4 py-2.5 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                <span>Role</span>
                <span>Permissões</span>
                <span>Tabelas</span>
                <span className="text-right">Acao</span>
              </div>
              <div className="divide-y divide-gray-100">
                {roles.map((role) => (
                  <div
                    key={role.name}
                    className="grid grid-cols-[1fr_1.6fr_120px_92px] gap-3 px-4 py-3 items-center hover:bg-gray-50/70"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{role.name}</p>
                      <p className="text-xs text-gray-400 truncate">{role.description || 'Sem descrição'}</p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {role.permissions.pages.slice(0, 5).map((route) => (
                        <span key={route} className="px-2 py-0.5 bg-gray-50 border border-gray-100 rounded text-[11px] text-gray-600">
                          {pages.find((page) => page.route === route)?.label || route}
                        </span>
                      ))}
                      {role.permissions.pages.length > 5 && (
                        <span className="px-2 py-0.5 bg-gray-100 rounded text-[11px] text-gray-500">
                          +{role.permissions.pages.length - 5}
                        </span>
                      )}
                      {role.permissions.canRunApiActions && (
                        <span className="px-2 py-0.5 bg-blue-50 border border-blue-100 rounded text-[11px] text-blue-700">
                          Executa API
                        </span>
                      )}
                    </div>
                    <span className={`w-fit px-2.5 py-1 rounded-md text-xs font-semibold ${
                      role.permissions.canCreateTables
                        ? 'bg-green-50 text-green-700'
                        : 'bg-gray-100 text-gray-500'
                    }`}>
                      {role.permissions.canCreateTables ? 'Cria' : 'Não cria'}
                    </span>
                    <button
                      onClick={() => openEditRole(role)}
                      className="justify-self-end inline-flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 rounded-lg text-xs font-medium text-gray-600 hover:text-[#730401] hover:border-[#730401]/30"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      Editar
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {currentPanelOpen && (
          <aside className="lg:w-[360px] bg-white rounded-xl shadow-sm border border-gray-200 h-fit sticky top-24">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                {activeTab === 'users' ? (
                  <UserPlus className="w-5 h-5 text-[#730401]" />
                ) : (
                  <Shield className="w-5 h-5 text-[#730401]" />
                )}
                <h2 className="font-semibold text-gray-900">
                  {activeTab === 'users'
                    ? userMode === 'create'
                      ? 'Novo usuário'
                      : 'Editar usuário'
                    : roleMode === 'create'
                      ? 'Nova role'
                      : 'Editar role'}
                </h2>
              </div>
              <button onClick={resetPanels} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-50 hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            {activeTab === 'users' ? (
              <div className="p-5 space-y-4">
                <input
                  value={userForm.name}
                  onChange={(e) => setUserForm((prev) => ({ ...prev, name: e.target.value }))}
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm"
                  placeholder="Nome"
                />
                <input
                  type="email"
                  value={userForm.email}
                  onChange={(e) => setUserForm((prev) => ({ ...prev, email: e.target.value }))}
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm"
                  placeholder="E-mail"
                />
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-gray-300 absolute left-3 top-3" />
                  <input
                    type="password"
                    value={userForm.password}
                    onChange={(e) => setUserForm((prev) => ({ ...prev, password: e.target.value }))}
                    className="w-full pl-9 pr-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm"
                    placeholder={userMode === 'create' ? 'Senha' : 'Nova senha opcional'}
                  />
                </div>
                <select
                  value={userForm.role}
                  onChange={(e) => setUserForm((prev) => ({ ...prev, role: e.target.value }))}
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm"
                >
                  {roleOptions.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
                <button
                  onClick={saveUser}
                  disabled={isSaving || !userForm.email || (userMode === 'create' && !userForm.password)}
                  className="w-full py-2.5 px-4 bg-[#730401] text-white font-medium rounded-lg hover:bg-[#5f0301] disabled:opacity-50 flex items-center justify-center"
                >
                  {isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                  Salvar
                </button>
              </div>
            ) : (
              <div className="p-5 space-y-4">
                <input
                  value={roleForm.name}
                  onChange={(e) => setRoleForm((prev) => ({ ...prev, name: e.target.value }))}
                  disabled={roleMode === 'edit'}
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm uppercase disabled:text-gray-400"
                  placeholder="NOME_DA_ROLE"
                />
                <input
                  value={roleForm.description}
                  onChange={(e) => setRoleForm((prev) => ({ ...prev, description: e.target.value }))}
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm"
                  placeholder="Descrição"
                />

                <div className="space-y-2">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Abas visíveis</p>
                  <div className="grid grid-cols-2 gap-2">
                    {pages.map((page) => (
                      <label key={page.route} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg border border-gray-100">
                        <span className="text-xs font-medium text-gray-700">{page.label}</span>
                        <input
                          type="checkbox"
                          checked={roleForm.pages.includes(page.route)}
                          onChange={() => toggleRolePage(page.route)}
                          className="h-4 w-4 accent-[#730401]"
                        />
                      </label>
                    ))}
                  </div>
                </div>

                <label className="flex items-start gap-3 p-3 bg-[#730401]/5 rounded-lg border border-[#730401]/20">
                  <input
                    type="checkbox"
                    checked={roleForm.canCreateTables}
                    onChange={(e) => setRoleForm((prev) => ({ ...prev, canCreateTables: e.target.checked }))}
                    className="mt-1 h-4 w-4 accent-[#730401]"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-[#730401]">Pode criar tabela</span>
                    <span className="block text-xs text-gray-500">Libera tabela nova no Upload.</span>
                  </span>
                </label>

                <label className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg border border-gray-200">
                  <input
                    type="checkbox"
                    checked={roleForm.canRunApiActions}
                    onChange={(e) => setRoleForm((prev) => ({ ...prev, canRunApiActions: e.target.checked }))}
                    className="mt-1 h-4 w-4 accent-[#730401]"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-gray-800">Pode reprocessar API</span>
                    <span className="block text-xs text-gray-500">Libera Reprocessar e Somente transformações na aba API.</span>
                  </span>
                </label>

                <button
                  onClick={saveRole}
                  disabled={isSaving || !roleForm.name}
                  className="w-full py-2.5 px-4 bg-[#730401] text-white font-medium rounded-lg hover:bg-[#5f0301] disabled:opacity-50 flex items-center justify-center"
                >
                  {isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                  Salvar role
                </button>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
