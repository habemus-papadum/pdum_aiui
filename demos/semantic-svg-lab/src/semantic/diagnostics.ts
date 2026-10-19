/** Local cross-domain experiment. References are opaque to the presenter. */
export interface TargetedDiagnostic {
  id: string;
  title: string;
  detail: string;
  refs: string[];
}
