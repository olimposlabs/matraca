# Instruções para o Codex

Siga o [guia para agentes](../AGENTS.md) e use o mapa de leitura para abrir apenas os documentos relevantes.

- Aplique o [formato obrigatório de mensagens](../AGENTS.md#formato-das-mensagens) a cada comunicação visível ao usuário. Recolha horário e franquia no mesmo turno imediatamente antes de enviar e use o fallback indicado se não conseguir identificar o limite do modelo.
- Ao receber um pedido de SPI, siga o [protocolo SPI](../docs/SMART_PHASES_IMPLEMENTATION.md). Mantenha o identificador da fase e o passo atual alinhados com o plano e as evidências de cada gate.
- Antes de declarar uma entrega concluída, verifique as evidências disponíveis. Separe o que foi validado do que ficou pendente ou **Não confirmado**. Para branches, checks, revisão e deploy, confirme o alvo e o SHA quando aplicável.
