export function validatePlanItems(raw: unknown, where = 'plan'): { errors: string[]; plan: PlanItem[] } {

export function validatePlanArtifact(doc: unknown, projectId: string): { errors?: string[]; plan?: PlanItem[] } {
