import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../api/auth/[...nextauth]/auth';
import {
  APP_PAGES,
  hasRouteAccess,
  normalizeRoleName,
  type RolePermissions,
} from '@/lib/auth/roles';
import {
  ensureRoleStorage,
  createCognitoUser,
  listRoles,
  listUsersWithRoles,
  updateCognitoUser,
  upsertRole,
} from '@/lib/auth/user-role-store';
import { createExecutionHistory } from '@/lib/aws/dynamodb-app-store';

export const dynamic = 'force-dynamic';

async function requireUserManagementAccess() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return { error: NextResponse.json({ error: 'Não autorizado' }, { status: 401 }) };
  }

  const user = session.user as any;
  if (!hasRouteAccess('/usuarios', user?.role, user?.permissions)) {
    return {
      error: NextResponse.json(
        { error: 'Sua role não pode gerenciar usuários e roles' },
        { status: 403 }
      ),
    };
  }

  return { session };
}

function normalizeRolePayload(body: any): {
  name: string;
  description: string | null;
  permissions: RolePermissions;
} {
  return {
    name: normalizeRoleName(body.name || body.roleName),
    description: String(body.description || '').trim() || null,
    permissions: {
      pages: Array.isArray(body.pages) ? body.pages : body.permissions?.pages || [],
      canCreateTables: Boolean(body.canCreateTables ?? body.permissions?.canCreateTables),
      canRunApiActions: Boolean(body.canRunApiActions ?? body.permissions?.canRunApiActions),
    },
  };
}

function formatUserManagementError(error: any) {
  const errorName = error?.name || error?.__type || '';
  const message = String(error?.message || '').trim();

  if (errorName === 'UsernameExistsException') {
    return 'Já existe um usuário cadastrado com este e-mail.';
  }
  if (errorName === 'InvalidPasswordException') {
    return `Senha inválida para a política do Cognito. ${message}`;
  }
  if (errorName === 'InvalidParameterException') {
    return `Parâmetro inválido no Cognito. ${message}`;
  }
  if (errorName === 'AccessDeniedException' || errorName === 'NotAuthorizedException') {
    return `Sem permissão para executar esta ação no Cognito. ${message}`;
  }
  if (errorName === 'ResourceNotFoundException') {
    return `Recurso do Cognito não encontrado. ${message}`;
  }

  return message || 'Erro ao salvar usuário ou role.';
}

async function createUserManagementAudit(input: {
  session: any;
  fileName: string;
  message: string;
  details?: any;
}) {
  const now = new Date();
  await createExecutionHistory({
    tableName: 'usuarios',
    fileName: input.fileName,
    status: 'SUCCESS',
    sourceType: 'admin',
    startTime: now,
    endTime: now,
    duration: 0,
    errors: JSON.stringify({
      type: 'Auditoria',
      message: input.message,
      details: input.details,
    }),
    userId: input.session?.user?.id,
    userEmail: input.session?.user?.email,
    userName: input.session?.user?.name,
  });
}

async function tryCreateUserManagementAudit(input: Parameters<typeof createUserManagementAudit>[0]) {
  try {
    await createUserManagementAudit(input);
  } catch (error: any) {
    console.error('User management audit log failed:', error);
  }
}

export async function GET() {
  try {
    const auth = await requireUserManagementAccess();
    if (auth.error) return auth.error;

    const [users, roles] = await Promise.all([listUsersWithRoles(), listRoles()]);
    return NextResponse.json({ users, roles, pages: APP_PAGES });
  } catch (error: any) {
    console.error('List users error:', error);
    return NextResponse.json({ error: 'Erro ao listar usuários' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireUserManagementAccess();
    if (auth.error) return auth.error;

    await ensureRoleStorage();
    const body = await req.json();

    if (body.type === 'role') {
      const role = normalizeRolePayload(body);
      const savedRole = await upsertRole(role.name, role.description, role.permissions);
      await tryCreateUserManagementAudit({
        session: auth.session,
        fileName: `Role criada ou atualizada - ${role.name}`,
        message: `Role ${role.name} criada ou atualizada.`,
        details: {
          action: 'role_upserted',
          role: savedRole,
        },
      });
      return NextResponse.json({ success: true, role: savedRole }, { status: 201 });
    }

    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const name = String(body.name || '').trim() || email.split('@')[0];
    const role = normalizeRoleName(body.role);

    if (!email || !password) {
      return NextResponse.json({ error: 'E-mail e senha são obrigatórios' }, { status: 400 });
    }

    if (password.length < 8) {
      return NextResponse.json({ error: 'Senha deve ter pelo menos 8 caracteres' }, { status: 400 });
    }

    const user = await createCognitoUser({
      email,
      password,
      name,
      role,
    });

    await tryCreateUserManagementAudit({
      session: auth.session,
      fileName: `Usuário criado - ${email}`,
      message: `Usuário ${email} criado.`,
      details: {
        action: 'user_created',
        email,
        name,
        role,
      },
    });

    return NextResponse.json(
      { success: true, user },
      { status: 201 }
    );
  } catch (error: any) {
    console.error('Create user/role error:', error);
    return NextResponse.json({ error: formatUserManagementError(error) }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await requireUserManagementAccess();
    if (auth.error) return auth.error;

    await ensureRoleStorage();
    const body = await req.json();

    if (body.type === 'role') {
      const role = normalizeRolePayload(body);
      const savedRole = await upsertRole(role.name, role.description, role.permissions);
      await tryCreateUserManagementAudit({
        session: auth.session,
        fileName: `Role editada - ${role.name}`,
        message: `Role ${role.name} editada.`,
        details: {
          action: 'role_updated',
          role: savedRole,
        },
      });
      return NextResponse.json({ success: true, role: savedRole });
    }

    const userId = String(body.userId || '').trim();
    const role = normalizeRoleName(body.role);
    const name = typeof body.name === 'string' ? body.name.trim() : undefined;
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : undefined;
    const password = typeof body.password === 'string' ? body.password : undefined;

    if (!userId) {
      return NextResponse.json({ error: 'Usuário é obrigatório' }, { status: 400 });
    }

    if (password && password.length < 8) {
      return NextResponse.json(
        { error: 'Senha deve ter pelo menos 8 caracteres' },
        { status: 400 }
      );
    }

    const user = await updateCognitoUser({
      userId,
      name,
      email,
      password,
      role,
    });

    await tryCreateUserManagementAudit({
      session: auth.session,
      fileName: `Usuário editado - ${email || userId}`,
      message: `Usuário ${email || userId} editado.`,
      details: {
        action: 'user_updated',
        userId,
        email,
        name,
        role,
        passwordChanged: Boolean(password),
      },
    });

    return NextResponse.json({ success: true, user });
  } catch (error: any) {
    console.error('Update user/role error:', error);
    return NextResponse.json({ error: formatUserManagementError(error) }, { status: 500 });
  }
}
