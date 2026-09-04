export type Permission = 'repricer';

export function hasPermission(role: string | undefined | null, permission: Permission): boolean {
    if (!role) return false;
    if (role === 'admin') return true;
    return role.split(',').map(p => p.trim()).includes(permission);
}

export function isAdmin(role: string | undefined | null): boolean {
    return role === 'admin';
}
