import { useState, useEffect, useCallback } from 'react';
import { authClient, useSession } from '../../lib/auth-client';
import styles from './UserManagement.module.css';

interface User {
    id: string;
    name: string;
    email: string;
    role: string;
    banned: boolean;
    createdAt: Date | string;
}

const PERMISSION_LABELS: Record<string, string> = {
    repricer: 'Репрайсер',
};

function roleToPermissions(role: string): string[] {
    if (role === 'admin') return ['admin'];
    return role.split(',').map(p => p.trim()).filter(Boolean);
}

function permissionsToRole(perms: string[]): string {
    if (perms.includes('admin')) return 'admin';
    if (perms.length === 0) return 'user';
    return perms.join(',');
}

export default function UserManagement() {
    const { data: session } = useSession();
    const [users, setUsers] = useState<User[]>([]);
    const [error, setError] = useState('');

    // New user form
    const [newName, setNewName] = useState('');
    const [newEmail, setNewEmail] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [newIsAdmin, setNewIsAdmin] = useState(false);
    const [newPerms, setNewPerms] = useState<string[]>(['repricer']);
    const [adding, setAdding] = useState(false);

    const isAdmin = session?.user?.role === 'admin';

    const loadUsers = useCallback(async () => {
        if (!isAdmin) return;
        try {
            const { data, error: err } = await authClient.admin.listUsers({
                query: { limit: 100 },
            });
            if (err) {
                setError(err.message || 'Ошибка загрузки пользователей');
            } else if (data) {
                setUsers(data.users as unknown as User[]);
            }
        } catch {
            setError('Не удалось загрузить пользователей');
        }
    }, [isAdmin]);

    useEffect(() => { loadUsers(); }, [loadUsers]);

    if (!isAdmin) return null;

    const handleAdd = async () => {
        if (!newEmail || !newPassword || !newName) return;
        setAdding(true);
        setError('');

        const role = newIsAdmin ? 'admin' : permissionsToRole(newPerms);

        try {
            const { error: err } = await authClient.admin.createUser({
                email: newEmail,
                password: newPassword,
                name: newName,
                role: role as 'admin' | 'user',
            });

            if (err) {
                setError(err.message || 'Ошибка создания');
            } else {
                setNewName('');
                setNewEmail('');
                setNewPassword('');
                setNewIsAdmin(false);
                setNewPerms(['repricer']);
                loadUsers();
            }
        } catch {
            setError('Ошибка создания пользователя');
        }
        setAdding(false);
    };

    const handleRoleChange = async (userId: string, newRole: string) => {
        setError('');
        const { error: err } = await authClient.admin.setRole({
            userId,
            role: newRole as 'admin' | 'user',
        });
        if (err) {
            setError(err.message || 'Ошибка смены роли');
        } else {
            loadUsers();
        }
    };

    const handleTogglePerm = (userId: string, currentRole: string, perm: string) => {
        if (currentRole === 'admin') return;
        const perms = roleToPermissions(currentRole);
        const newPerms = perms.includes(perm)
            ? perms.filter(p => p !== perm)
            : [...perms, perm];
        handleRoleChange(userId, permissionsToRole(newPerms));
    };

    const handleToggleAdmin = (userId: string, currentRole: string) => {
        if (currentRole === 'admin') {
            handleRoleChange(userId, 'repricer');
        } else {
            handleRoleChange(userId, 'admin');
        }
    };

    const handleDelete = async (userId: string) => {
        if (userId === session?.user?.id) return;
        if (!confirm('Удалить пользователя?')) return;

        const { error: err } = await authClient.admin.removeUser({ userId });
        if (err) {
            setError(err.message || 'Ошибка удаления');
        } else {
            loadUsers();
        }
    };

    const toggleNewPerm = (perm: string) => {
        setNewPerms(prev =>
            prev.includes(perm) ? prev.filter(p => p !== perm) : [...prev, perm]
        );
    };

    return (
        <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Пользователи</h2>

            <table className={styles.userTable}>
                <thead>
                    <tr>
                        <th>Имя</th>
                        <th>Email</th>
                        <th>Админ</th>
                        <th>Репрайсер</th>
                        <th>Сборка</th>
                        <th>Создан</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    {users.map((u) => {
                        const perms = roleToPermissions(u.role);
                        const isUserAdmin = u.role === 'admin';
                        const isSelf = u.id === session?.user?.id;
                        return (
                            <tr key={u.id}>
                                <td>{u.name}</td>
                                <td>{u.email}</td>
                                <td>
                                    <input
                                        type="checkbox"
                                        checked={isUserAdmin}
                                        onChange={() => handleToggleAdmin(u.id, u.role)}
                                        disabled={isSelf}
                                        className={styles.checkbox}
                                    />
                                </td>
                                <td>
                                    <input
                                        type="checkbox"
                                        checked={isUserAdmin || perms.includes('repricer')}
                                        onChange={() => handleTogglePerm(u.id, u.role, 'repricer')}
                                        disabled={isUserAdmin || isSelf}
                                        className={styles.checkbox}
                                    />
                                </td>
                                <td>{new Date(u.createdAt).toLocaleDateString('ru')}</td>
                                <td>
                                    {!isSelf && (
                                        <button className={styles.deleteBtn} onClick={() => handleDelete(u.id)}>
                                            Удалить
                                        </button>
                                    )}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>

            <div className={styles.addForm}>
                <input placeholder="Имя" value={newName} onChange={(e) => setNewName(e.target.value)} />
                <input placeholder="Email" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
                <input placeholder="Пароль" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                <label className={styles.permLabel}>
                    <input type="checkbox" checked={newIsAdmin} onChange={(e) => setNewIsAdmin(e.target.checked)} />
                    Админ
                </label>
                {!newIsAdmin && Object.entries(PERMISSION_LABELS).map(([key, label]) => (
                    <label key={key} className={styles.permLabel}>
                        <input
                            type="checkbox"
                            checked={newPerms.includes(key)}
                            onChange={() => toggleNewPerm(key)}
                        />
                        {label}
                    </label>
                ))}
                <button className={styles.addBtn} onClick={handleAdd} disabled={adding || !newEmail || !newPassword || !newName}>
                    {adding ? 'Создание...' : 'Добавить'}
                </button>
            </div>

            {error && <div className={styles.error}>{error}</div>}
        </div>
    );
}
