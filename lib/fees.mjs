/* Estimated commissions for planning only. Broker CSV commissions are authoritative. */
export const DEFAULT_BUY_FEE_USD = 0.77;
export const DEFAULT_SELL_FEE_USD = 1.00;
export const feeRuleKey = side => String(side||'').toUpperCase()==='SELL'?'sellFeePerContractUsd':'buyFeePerContractUsd';
export function ratePerContract(account,side){
  const key=feeRuleKey(side),fallback=key==='buyFeePerContractUsd'?DEFAULT_BUY_FEE_USD:DEFAULT_SELL_FEE_USD;
  const n=Number(account?.[key]);
  return account?.[key]===null||account?.[key]===undefined||account?.[key]===''||!Number.isFinite(n)||n<0||n>1000?fallback:n;
}
export function estimateOrderFee(account,side,qty){
  const n=Number(qty);
  if(!Number.isInteger(n)||n<1||n>99999)return 0;
  return Math.round((ratePerContract(account,side)*n+Number.EPSILON)*100)/100;
}
