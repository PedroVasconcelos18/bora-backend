/**
 * Serializa um erro desconhecido para log.
 *
 * O SDK do Mercado Pago rejeita com um objeto simples (`{ status, message,
 * cause }`), não com uma instância de `Error`. Um `String(err)` nesse objeto
 * produz `"[object Object]"` — o motivo real da recusa (ex.: conta sem chave
 * Pix cadastrada) some do log e a falha vira um mistério em produção.
 *
 * Destino: LOG apenas. O cliente continua recebendo a 503 genérica — nada
 * daqui pode vazar na resposta HTTP.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }

  if (typeof err === 'object' && err !== null) {
    // Copia as own properties (inclusive as não-enumeráveis, que o SDK usa)
    // para um objeto plano. NÃO usar `JSON.stringify(err, ownPropNames)`: ali o
    // array vira um filtro de chaves aplicado em TODOS os níveis, e o `cause`
    // do MP — que carrega o código e a descrição do motivo — sai como `[{}]`.
    const plain: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(err)) {
      plain[key] = (err as Record<string, unknown>)[key];
    }

    try {
      return JSON.stringify(plain);
    } catch {
      // JSON.stringify lança em referência circular — nunca deixe o próprio
      // logging derrubar o handler.
      return Object.prototype.toString.call(err);
    }
  }

  return String(err);
}
