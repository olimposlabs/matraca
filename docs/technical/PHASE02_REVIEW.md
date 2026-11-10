# F02 — revisão de identidade e isolamento

Revisão interna independente da identidade local, com PostgreSQL real e caixa de e-mail simulada em disco. Não substitui a revisão externa da PR nem comprova implantação em AWS, autorização dos recursos de fases futuras ou conclusão do piloto.

## Escopo e fronteiras

Foram examinados `server/auth.ts`, a migração `002_identity.sql`, a integração em `server/app.ts` e a configuração de acesso a arquivos do Vite. Os testes estão em [identity.test.ts](../../tests/identity.test.ts) e [dev-boundary.test.ts](../../tests/dev-boundary.test.ts).

A suíte de identidade cria um schema PostgreSQL com nome aleatório e injeta `search_path` na URL de conexão de cada pool da aplicação. Migrações e dados sintéticos são criados somente nesse schema. A finalização remove exclusivamente esse schema e seu diretório temporário. Nenhuma tabela ou conta de demonstração é truncada.

## Evidências executadas

Execução com Node `24.22.2`, Vitest `4.1.12` e PostgreSQL 17 local:

| Fronteira | Evidência |
| --- | --- |
| Organizações | Quatro hosts resolvem organizações distintas; host desconhecido retorna `404` e sessão anônima retorna `401` |
| Cadastro | Matraca concede somente `student`; parceiro rejeita cadastro público; campos adicionais de papel/organização são rejeitados; novo cadastro não reativa usuário suspenso |
| Links de acesso | Resposta `202` genérica para usuário existente, desconhecido ou suspenso, sem token na resposta; limite de cinco emissões por e-mail/host |
| Identidades | Mesmo e-mail em três organizações cria contas e sessões distintas; nenhuma sessão funciona nos outros hosts |
| Backoffice | Operador autentica no contexto próprio; papéis incompatíveis com o tipo da organização não recebem link |
| Tokens | Host errado não consome o token do host correto; replay e expiração falham; duas requisições concorrentes produzem somente uma sessão |
| Convites e suspensão | Convite ativa o usuário preservando papéis; suspensão antes do consumo impede criar sessão; suspensão posterior de usuário ou organização invalida acesso |
| Sessões | Papéis atuais são relidos; expiração e logout impedem reutilização; recriar a aplicação preserva sessão válida no banco |
| Cookies e origem | Cookie sem `Domain`, com `HttpOnly`, `Path=/` e `SameSite`; mutações sem header explícito ou com origem externa/malformada são rejeitadas |
| Caixa local | Banco armazena hash SHA-256 do token; arquivo tem modo `0600` e diretório por organização `0700`; não existe endpoint público de mailbox |
| Servidor web | CSS público responde `200`; marcador privado é bloqueado com `403` por caminho relativo e `/@fs`, inclusive com `?raw` |

A rodada completa dos dois arquivos passou: **29 testes, sem skips**, sendo 28 de identidade e um da fronteira de arquivos do Vite. Lint dos dois arquivos, `tsc --noEmit` e `git diff --check` também passaram. O teste de Vite usa um marcador sintético, abre uma porta local efêmera e remove somente seu próprio subdiretório em `.data`. Não lê nem expõe tokens reais da mailbox.

O teste de fronteira também usa `cacheDir` exclusivo dentro desse subdiretório. A primeira versão compartilhou o cache de dependências com o Vite interativo, causando respostas `504` no frontend ativo; o cache foi isolado e a regressão foi repetida com sucesso. Executar o teste não deve reconfigurar o cache da aplicação usada pelo navegador.

## Achado corrigido durante a revisão

A configuração inicial do Vite permitia carregar `.data/mailbox` pela raiz de desenvolvimento: `isFileLoadingAllowed` retornou `true` para um caminho sintético nessa árvore. Permissões Unix de arquivo não impedem o servidor web, executado pelo mesmo usuário, de servir esse conteúdo.

A configuração foi restringida aos arquivos públicos necessários do frontend e passou a negar `.data` e diretórios `mailbox`, preservando os bloqueios padrão. A regressão HTTP descrita acima confirmou o bloqueio no servidor real. Não foi necessário abrir qualquer mensagem de acesso real para reproduzir a falha ou verificar a correção.

## Leitura de segurança

A implementação usa tokens aleatórios, hashes no banco, chaves estrangeiras compostas para os vínculos de organização/usuário/host e transação com lock para consumir o link e criar a sessão. A autorização de sessão consulta novamente o vínculo de domínio, o status da organização, o status do usuário e seus papéis. A restrição de operador ao backoffice também ocorre no servidor.

Não foram identificados achados bloqueantes pendentes nesse escopo após corrigir a fronteira do Vite. A revisão não equivale a um teste de intrusão completo. Autorização por escola, turma, professor, arquivo, curso e operação financeira ainda exige os testes das fases que introduzirem esses recursos. A caixa em disco é exclusiva do ambiente local; entrega real de e-mail e configuração de proxy/TLS de produção não foram validadas.

## Gates externos

CI remota, revisão GitHub Codex Review, SHA final e merge da F02 permanecem **Não confirmados** neste relatório. As evidências locais não encerram esses gates do protocolo SPI.
