# Pipeline Upload App

Aplicacao interna em Next.js para centralizar fluxos de ingestao de dados. A plataforma suporta upload manual de planilhas, disparo de ingestao via API, importacao do `scheduler_calendar`, historico, monitoramento e controle de acesso por usuarios e roles.

## Arquitetura

- **Next.js 14**: interface e rotas backend.
- **Cognito User Pool**: autenticacao, usuarios e grupos/roles.
- **AWS S3**: armazenamento dos arquivos enviados.
- **AWS Step Functions**: execucao dos pipelines.
- **AWS DynamoDB**: catalogos, configuracoes de tabelas, controle das APIs e historico operacional.
- **Athena**: deve ser usado para consulta analitica dos dados do cliente, nao para login ou controle de usuarios.

## Usuarios E Roles

O controle de usuarios foi migrado para **Amazon Cognito**.

- Usuarios sao criados no Cognito pela tela `/usuarios`.
- Roles sao grupos do Cognito, como `ADMIN` e `USER`.
- Permissoes finas de cada role ficam salvas na descricao JSON do grupo Cognito.
- O login usa o Hosted UI/OAuth do Cognito via NextAuth.
- A aplicacao le os grupos do token e libera as abas conforme as permissoes.

### Primeiro ADMIN

Para uma instalacao zerada, faca assim:

1. Crie o User Pool no Cognito.
2. Crie um App Client com secret.
3. Configure o callback URL:

```text
https://SEU_DOMINIO/api/auth/callback/cognito
```

Para desenvolvimento local, adicione tambem:

```text
http://localhost:3000/api/auth/callback/cognito
```

4. Crie o primeiro usuario no Cognito pelo Console AWS.
5. Coloque o e-mail desse usuario na variavel `ADMIN_EMAILS` no primeiro deploy, ou crie o grupo `ADMIN` no Cognito e adicione o usuario nele.
6. Acesse a aplicacao com esse usuario.
7. Use `/usuarios` para criar os demais usuarios e roles.

Depois que o primeiro usuario estiver no grupo `ADMIN`, a variavel `ADMIN_EMAILS` pode ficar vazia.

## Variaveis De Ambiente

Copie `.env.example` para `.env` em desenvolvimento local. Em EC2, configure essas variaveis no ambiente do processo.

```bash
cp .env.example .env
```

Principais variaveis:

- `NEXTAUTH_SECRET`: segredo forte para assinar sessoes.
- `NEXTAUTH_URL`: URL publica da aplicacao.
- `NEXT_PUBLIC_APP_BRAND_NAME`: Nome da Marca do cliente
- `MANUAL_UPLOAD_CRAWLER_TIMEOUT_SECONDS`: tempo maximo para o upload manual sair de `CRAWLING` antes de marcar erro. Padrao: `60`.
- `COGNITO_CLIENT_ID`: App Client ID do Cognito.
- `COGNITO_CLIENT_SECRET`: App Client Secret do Cognito.
- `COGNITO_ISSUER`: issuer do User Pool, no formato `https://cognito-idp.REGION.amazonaws.com/USER_POOL_ID`.
- `COGNITO_USER_POOL_ID`: ID do User Pool usado pelas APIs administrativas.
- `ADMIN_EMAILS`: fallback opcional para primeiro acesso ADMIN.
- `AWS_MOCK_MODE`: use `true` apenas para desenvolvimento sem chamadas AWS reais.
- `AWS_REGION`: regiao AWS.
- `AWS_S3_BUCKET_XLSX`: bucket transient que recebe os arquivos manuais, sem `s3://`.
- `AWS_S3_XLSX_PREFIX`: prefixo do bucket para arquivos manuais.
- `AWS_S3_SCHEDULER_CALENDAR_BUCKET`, `AWS_S3_SCHEDULER_CALENDAR_PREFIX`: destino do scheduler calendar.
- `AWS_S3_EXTRACTION_BUCKET`, `AWS_S3_EXTRACTION_PREFIX`: destino das querys de extração
- `EXTRACTION_TABLE_NAME`: tabela utilizada para extração final
- `AWS_STEP_FUNCTION_INGESTION_MASTER_ARN`: ARN da Step Function unica de ingestao.
- `AWS_STEP_FUNCTION_TRANSFORMATION_ONLY_ARN`: ARN da Step Function de somente transformação.
- `AWS_DYNAMODB_CONFIG_TABLE`: tabela do dynamo com metadados de tabelas de ingestão manual.
- `AWS_DYNAMODB_INGESTION_RAW_TABLE`: configuracoes das APIs usadas pela Step Function.
- `AWS_DYNAMODB_INGESTION_RAW_IGNORE_TABLE`: controle de tabelas ignoradas no fluxo API.
- `AWS_DYNAMODB_EXECUTION_HISTORY_TABLE`: historico operacional exibido em historico/monitoramento. Sugestao de nome: `ingestion-app-execution-history`.
- `MANUAL_INGESTION_ORIGIN_PREFIX`: prefixo S3 de origem da ingestão manual.
- `MANUAL_INGESTION_DESTINATION_BUCKET`, `MANUAL_INGESTION_DESTINATION_PREFIX`: Bucket de destino dos arquivos `parquet`.
- `MANUAL_INGESTION_PROCESSING_TYPE`: tipo de arquivo para ingestão. Padrão: `xlsx`
- `MANUAL_INGESTION_TYPE_PROCESS`: Padrão: `lambda`
- `MANUAL_INGESTION_LOAD_FULL`: se as tabelas serão full load ou não.
- `MANUAL_INGESTION_VISIBLE_ORIGIN_PATH_PREFIX`: prefixo S3 de origem da ingestão manual.

As variaveis de DynamoDB esperam **nome da tabela**, nao ARN.

Na tabela manual, cada item segue o modelo operacional existente:

- Tabela DynamoDB: `TABELA_DYNAMO_INGESTAO_MANUAL`.
- Partition key: `origin_path`.
- `origin_path`: `{ORIGIN_PATH}/{dataset_name}/`.
- `dataset_name`: nome normalizado da tabela importada.
- `data_schema`: Map com nome da coluna e tipo.
- `destination_bucket`: `{DESTINATION_BUCKET}`.
- `destination_path`: `{DESTINATION_PATH}/{dataset_name}/`.
- `load_full`: `false`.
- `processing_type`: `xlsx`.
- `type_process`: `lambda`.

Nao versione `.env`, credenciais, ARNs reais, nomes internos de buckets ou IDs de conta AWS.

## Permissoes AWS Da EC2

Prefira usar **IAM Role anexada a EC2** em vez de chaves fixas no `.env`.

A role da EC2 precisa, conforme o uso do ambiente, de permissoes para:

- Cognito Identity Provider: listar/criar/atualizar usuarios e grupos no User Pool.
- S3: enviar arquivos para os buckets configurados.
- Step Functions: iniciar e consultar execucoes.
- DynamoDB: ler/escrever nas tabelas operacionais configuradas.
- GlueCrawler: monitorar execução de ingestão manual

## Setup Local

Instale dependencias:

```bash
npm install --legacy-peer-deps
```

Inicie o servidor:

```bash
npm run dev
```

Acesse `http://localhost:3000`.

Para login local, use um User Pool Cognito com callback local configurado.

## Deploy Em EC2

Fluxo sugerido para uma EC2 limpa:

```bash
npm ci --legacy-peer-deps
npm run build
npm run start
```

Para producao, rode o processo com `pm2`, `systemd` ou outro supervisor. As tabelas DynamoDB indicadas nas variaveis de ambiente devem existir e estar acessiveis pela role IAM da EC2.

## Scripts

```bash
npm run dev           # desenvolvimento
npm run build         # build de producao
npm run start         # inicia build de producao
npm run lint          # lint
```

## Areas Da Aplicacao

- `/upload`: upload manual de planilhas.
- `/api-ingestao`: operacao de ingestao via API.
- `/scheduler-calendar`: envio do calendario do scheduler.
- `/monitoramento`: metricas e acompanhamento operacional.
- `/tabelas`: configuracao das tabelas de ingestao.
- `/usuarios`: administracao de usuarios e roles via Cognito.

## Seguranca

- O login e o cadastro de usuarios ficam no Cognito.
- A aplicacao nao armazena senhas localmente.
- Arquivos `.env`, `.env.local`, `.next`, `node_modules` e caches locais nao devem ser versionados.
- Segredos devem ficar no ambiente da EC2, em Secrets Manager/SSM Parameter Store ou no provedor de deploy.
- Athena nao deve ser usado como banco de usuarios.

## Troubleshooting

### Login nao redireciona corretamente

- Confirme `NEXTAUTH_URL`.
- Confirme `COGNITO_ISSUER`.
- Confira se o callback URL no Cognito termina com `/api/auth/callback/cognito`.

### Usuario loga mas nao ve a aba Usuarios

- Adicione o usuario ao grupo `ADMIN` no Cognito, ou configure temporariamente o email em `ADMIN_EMAILS`.
- Faca logout/login para renovar o token com os grupos atualizados.

### DynamoDB operacional nao conecta

- Verifique as variaveis `AWS_DYNAMODB_*`.
- Confirme se as tabelas existem na regiao configurada.
- Confirme permissoes `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:UpdateItem`, `dynamodb:Scan` e `dynamodb:Query` na role da EC2.

### APIs AWS falham

- Verifique a IAM Role da EC2.
- Confirme regiao e nomes/ARNs configurados.
- Consulte CloudWatch para detalhes da execucao.
