import type { CoreEvents } from '@core/events';
import { EventBus } from '@core/events';
import { MemoryAuthSessionRepository } from '@core/repositories';
import { AuthSessionService } from '@core/services';
import { beforeEach, describe, expect, it } from 'bun:test';


describe('AuthSessionService', () => {
    const mintUrl = 'https://mint.test'
    let repo: MemoryAuthSessionRepository;
    let bus: EventBus<CoreEvents>
    let service: AuthSessionService;

    beforeEach(() => {
        repo = new MemoryAuthSessionRepository();
        bus = new EventBus<CoreEvents>;
        service = new AuthSessionService(repo, bus);
    });

    it('saves and retrieves a valid session', async() =>{
        await service.saveSession(mintUrl, {
            access_token:'abc_123',
            refresh_token:'def_456',
            expires_in:3600,
        });
        const session = await service.getValidSession(mintUrl);

        expect(session.accessToken).toBe('abc_123');
        expect(session.refreshToken).toBe('def_456');
    });
    
    it('emits auth-session:updated on save', async() => {
        const events: string[] = [];
        bus.on('auth-session:updated', (payload) => {
            events.push(payload.mintUrl);
        });
        await service.saveSession(mintUrl, {access_token: 'abc'});

        expect(events).toEqual([mintUrl]);
    })
    
    it('throws AuthSessionExpiredError on expired session', async()=> {
        //save expired session for test
        await repo.saveSession({
            mintUrl,
            accessToken: 'old',
            expiresAt: 0,
        });
        await expect(service.getValidSession(mintUrl)).rejects.toThrow('expired');
    });

    it('throws on non-existent session', async() => {
        await expect(service.getValidSession(mintUrl)).rejects.toThrow('No auth session found');
    })

    it('normalizes mint URL', async() => {
        //save URL with '/'
        await service.saveSession('https://mint.test/', {access_token:'abc'});

        //get Session without '/'
        const session = await service.getValidSession('https://mint.test');

        expect(session.accessToken).toBe('abc');
    });

    it('deletes session and emits event', async() =>{
        const events: string[] = [];
        bus.on('auth-session:deleted', (p) => {events.push(p.mintUrl)} );
        await service.saveSession(mintUrl, {access_token: 'abc'});
        await service.deleteSession(mintUrl);

        await expect(service.getValidSession(mintUrl)).rejects.toThrow();
        expect(events).toEqual([mintUrl]);
    })

    it('hasSession returns true for valid session', async () => {
        await service.saveSession(mintUrl, {
            access_token: 'abc',
            expires_in: 3600,
        });
        expect(await service.hasSession(mintUrl)).toBe(true);
    });

    it('hasSession returns false for expired session', async () => {
        await repo.saveSession({
            mintUrl,
            accessToken: 'old',
            expiresAt: 0,
        });
        expect(await service.hasSession(mintUrl)).toBe(false);
    });

    it('hasSession returns false for non-existent session', async () => {
        expect(await service.hasSession(mintUrl)).toBe(false);
    });

    it('saves and retrieves session with batPool', async () => {
        const batPool = [
            { id: 'key1', amount: 1, secret: 's1', C: 'c1' },
            { id: 'key1', amount: 2, secret: 's2', C: 'c2' },
        ] as any;

        await service.saveSession(mintUrl, {
            access_token: 'abc',
            expires_in: 3600,
        }, batPool);

        const session = await service.getValidSession(mintUrl);
        expect(session.batPool).toEqual(batPool);
        expect(session.batPool).toHaveLength(2);
    });

    it('saves session without batPool (backward compat)', async () => {
        await service.saveSession(mintUrl, {
            access_token: 'abc',
            expires_in: 3600,
        });

        const session = await service.getValidSession(mintUrl);
        expect(session.batPool).toBeUndefined();
    });
});