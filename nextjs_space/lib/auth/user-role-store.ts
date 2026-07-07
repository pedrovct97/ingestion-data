import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  CreateGroupCommand,
  GroupType,
  ListGroupsCommand,
  ListUsersCommand,
  UpdateGroupCommand,
  UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  DEFAULT_ROLE_PERMISSIONS,
  getDefaultPermissionsForRole,
  normalizePermissions,
  normalizeRoleName,
  type RolePermissions,
} from './roles';

interface RoleDescriptionPayload {
  description?: string | null;
  permissions?: Partial<RolePermissions>;
}

// Toda gestao de usuarios e roles usa Cognito User Pool.
// Os grupos do Cognito representam roles, e a Description do grupo guarda um
// JSON com permissoes de paginas. Assim nao precisamos de Postgres/Prisma.
export interface ManagedCognitoUser {
  id: string;
  name: string | null;
  email: string;
  role: string;
  createdAt: string;
  enabled: boolean;
}

// Centraliza variaveis do Cognito para falhar cedo quando o ambiente estiver
// incompleto. A aplicacao precisa de COGNITO_USER_POOL_ID para administrar
// usuarios e grupos.
function getCognitoConfig() {
  const region = process.env.AWS_REGION || process.env.COGNITO_REGION || 'us-east-1';
  const userPoolId = process.env.COGNITO_USER_POOL_ID;

  if (!userPoolId) {
    throw new Error('COGNITO_USER_POOL_ID não configurado');
  }

  return { region, userPoolId };
}

function createCognitoClient() {
  const { region } = getCognitoConfig();
  return new CognitoIdentityProviderClient({ region });
}

// A Description do grupo pode ser texto legado ou JSON novo. Este parser aceita
// os dois formatos para nao quebrar grupos criados manualmente no console AWS.
function parseRoleDescription(value?: string | null): {
  description: string | null;
  permissions: RolePermissions;
} {
  if (!value) {
    return { description: null, permissions: normalizePermissions(null) };
  }

  try {
    const parsed = JSON.parse(value) as RoleDescriptionPayload;
    return {
      description: parsed.description || null,
      permissions: normalizePermissions(parsed.permissions || null),
    };
  } catch {
    return { description: value, permissions: normalizePermissions(null) };
  }
}

function serializeRoleDescription(
  description: string | null,
  permissions: Partial<RolePermissions>
) {
  return JSON.stringify({
    description,
    permissions: normalizePermissions(permissions),
  });
}

function mapGroup(group: GroupType) {
  const parsed = parseRoleDescription(group.Description);
  const roleName = normalizeRoleName(group.GroupName);
  const permissions = parsed.permissions.pages.length
    ? parsed.permissions
    : getDefaultPermissionsForRole(roleName);

  return {
    name: roleName,
    description: parsed.description,
    permissions,
    createdAt: group.CreationDate,
    updatedAt: group.LastModifiedDate,
  };
}

function getUserAttribute(user: UserType, name: string) {
  return user.Attributes?.find((attribute) => attribute.Name === name)?.Value || '';
}

function getAdminRole(groups: string[]) {
  const normalized = groups.map(normalizeRoleName);
  if (normalized.includes('ADMIN')) return 'ADMIN';
  return normalized[0] || 'USER';
}

export async function ensureRoleStorage() {
  const { userPoolId } = getCognitoConfig();
  const client = createCognitoClient();

  const existingGroups = await listCognitoGroups();
  const existingNames = new Set(existingGroups.map((group) => group.name));

  for (const [name, permissions] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    if (existingNames.has(name)) continue;

    await client.send(
      new CreateGroupCommand({
        UserPoolId: userPoolId,
        GroupName: name,
        Description: serializeRoleDescription(
          name === 'ADMIN' ? 'Acesso completo ao sistema' : 'Acesso operacional basico',
          permissions
        ),
      })
    );
  }
}

// Busca a role atual do usuario consultando os grupos do Cognito.
// ADMIN tem prioridade quando o usuario estiver em mais de um grupo.
async function listCognitoGroups() {
  const { userPoolId } = getCognitoConfig();
  const client = createCognitoClient();
  const groups: GroupType[] = [];
  let NextToken: string | undefined;

  do {
    const response = await client.send(new ListGroupsCommand({ UserPoolId: userPoolId, NextToken }));
    groups.push(...(response.Groups || []));
    NextToken = response.NextToken;
  } while (NextToken);

  return groups.map(mapGroup);
}

export async function getUserRole(_userId: string, email?: string | null): Promise<string> {
  if (!email) return 'USER';

  const { userPoolId } = getCognitoConfig();
  const client = createCognitoClient();
  const response = await client.send(
    new AdminListGroupsForUserCommand({ UserPoolId: userPoolId, Username: email })
  );

  return getAdminRole((response.Groups || []).map((group) => group.GroupName || ''));
}

export async function getRolePermissions(role: string): Promise<RolePermissions> {
  await ensureRoleStorage();
  const roleName = normalizeRoleName(role);
  const roleConfig = (await listCognitoGroups()).find((group) => group.name === roleName);
  return roleConfig?.permissions || getDefaultPermissionsForRole(roleName);
}

export async function setUserRole(username: string, role: string) {
  const { userPoolId } = getCognitoConfig();
  const client = createCognitoClient();
  const roleName = normalizeRoleName(role);
  await ensureRoleStorage();

  const groups = await listCognitoGroups();
  const roleNames = new Set(groups.map((group) => group.name));
  const currentGroups = await client.send(
    new AdminListGroupsForUserCommand({ UserPoolId: userPoolId, Username: username })
  );

  for (const group of currentGroups.Groups || []) {
    const groupName = normalizeRoleName(group.GroupName);
    if (roleNames.has(groupName) && groupName !== roleName) {
      await client.send(
        new AdminRemoveUserFromGroupCommand({
          UserPoolId: userPoolId,
          Username: username,
          GroupName: groupName,
        })
      );
    }
  }

  await client.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: username,
      GroupName: roleName,
    })
  );
}

// Lista usuarios do Cognito e anexa a role calculada por grupos. Esta funcao
// alimenta a tela /usuarios sem depender de banco relacional.
export async function listUsersWithRoles(): Promise<ManagedCognitoUser[]> {
  await ensureRoleStorage();

  const { userPoolId } = getCognitoConfig();
  const client = createCognitoClient();
  const users: UserType[] = [];
  let PaginationToken: string | undefined;

  do {
    const response = await client.send(
      new ListUsersCommand({ UserPoolId: userPoolId, PaginationToken, Limit: 60 })
    );
    users.push(...(response.Users || []));
    PaginationToken = response.PaginationToken;
  } while (PaginationToken);

  return Promise.all(
    users.map(async (user) => {
      const email = getUserAttribute(user, 'email') || user.Username || '';
      const groups = await client.send(
        new AdminListGroupsForUserCommand({
          UserPoolId: userPoolId,
          Username: user.Username || email,
        })
      );

      return {
        id: user.Username || email,
        name: getUserAttribute(user, 'name') || null,
        email,
        role: getAdminRole((groups.Groups || []).map((group) => group.GroupName || '')),
        createdAt: (user.UserCreateDate || new Date()).toISOString(),
        enabled: Boolean(user.Enabled),
      };
    })
  );
}

export async function listRoles() {
  await ensureRoleStorage();
  return listCognitoGroups();
}

export async function upsertRole(
  role: string,
  description: string | null,
  permissions: Partial<RolePermissions>
) {
  const { userPoolId } = getCognitoConfig();
  const client = createCognitoClient();
  const name = normalizeRoleName(role);
  const normalizedPermissions = normalizePermissions(permissions);
  const Description = serializeRoleDescription(description, normalizedPermissions);
  const exists = (await listCognitoGroups()).some((group) => group.name === name);

  if (exists) {
    await client.send(new UpdateGroupCommand({ UserPoolId: userPoolId, GroupName: name, Description }));
  } else {
    await client.send(new CreateGroupCommand({ UserPoolId: userPoolId, GroupName: name, Description }));
  }

  return { name, description, permissions: normalizedPermissions };
}

export async function createCognitoUser(input: {
  email: string;
  name?: string | null;
  password: string;
  role: string;
}) {
  const { userPoolId } = getCognitoConfig();
  const client = createCognitoClient();
  const email = input.email.trim().toLowerCase();

  await client.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      TemporaryPassword: input.password,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: input.name || email.split('@')[0] },
      ],
    })
  );

  await client.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: email,
      Password: input.password,
      Permanent: true,
    })
  );
  await setUserRole(email, input.role);

  return { id: email, email, name: input.name || email.split('@')[0], role: normalizeRoleName(input.role) };
}

// Atualiza atributos basicos, senha e role. A role e aplicada por grupos:
// removemos grupos de role antigos e adicionamos o grupo escolhido.
export async function updateCognitoUser(input: {
  userId: string;
  email?: string;
  name?: string | null;
  password?: string;
  role: string;
}) {
  const { userPoolId } = getCognitoConfig();
  const client = createCognitoClient();
  const username = input.userId;
  const attributes = [];

  if (input.email) attributes.push({ Name: 'email', Value: input.email.trim().toLowerCase() });
  if (input.name !== undefined) attributes.push({ Name: 'name', Value: input.name || '' });

  if (attributes.length) {
    await client.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: userPoolId,
        Username: username,
        UserAttributes: attributes,
      })
    );
  }

  if (input.password) {
    await client.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId,
        Username: username,
        Password: input.password,
        Permanent: true,
      })
    );
  }

  await setUserRole(username, input.role);
  return { id: username, email: input.email, name: input.name, role: normalizeRoleName(input.role) };
}

export async function getCognitoUserByUsername(username: string) {
  const { userPoolId } = getCognitoConfig();
  const client = createCognitoClient();
  const response = await client.send(
    new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username })
  );

  return {
    id: response.Username || username,
    email: response.UserAttributes?.find((attribute) => attribute.Name === 'email')?.Value || username,
    name: response.UserAttributes?.find((attribute) => attribute.Name === 'name')?.Value || null,
  };
}

export async function setCognitoUserEnabled(username: string, enabled: boolean) {
  const { userPoolId } = getCognitoConfig();
  const client = createCognitoClient();
  await client.send(
    enabled
      ? new AdminEnableUserCommand({ UserPoolId: userPoolId, Username: username })
      : new AdminDisableUserCommand({ UserPoolId: userPoolId, Username: username })
  );
}

export async function deleteCognitoUser(username: string) {
  const { userPoolId } = getCognitoConfig();
  const client = createCognitoClient();
  await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }));
}
