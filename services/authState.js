import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import { supabase } from './db.js';

export const useSupabaseAuthState = async () => {
    const writeData = async (data, id) => {
        try {
            // BufferJSON stringifies Uint8Arrays properly
            const stringified = JSON.stringify(data, BufferJSON.replacer);
            const parsedData = JSON.parse(stringified);
            
            const { error } = await supabase
                .from('baileys_auth')
                .upsert({ id, data: parsedData });
                
            if (error) console.error(`Error saving auth state for ${id}:`, error);
        } catch (error) {
            console.error('Error writing auth state to Supabase:', error);
        }
    };

    const readData = async (id) => {
        try {
            const { data, error } = await supabase
                .from('baileys_auth')
                .select('data')
                .eq('id', id)
                .single();

            if (error || !data) return null;
            
            // Reconstruct Buffers
            const stringified = JSON.stringify(data.data);
            return JSON.parse(stringified, BufferJSON.reviver);
        } catch (error) {
            console.error('Error reading auth state from Supabase:', error);
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            const { error } = await supabase
                .from('baileys_auth')
                .delete()
                .eq('id', id);
            
            if (error) console.error(`Error deleting auth state for ${id}:`, error);
        } catch (error) {
            console.error('Error removing auth state from Supabase:', error);
        }
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async id => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const upserts = [];
                    const deletes = [];
                    
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                const stringified = JSON.stringify(value, BufferJSON.replacer);
                                upserts.push({ id: key, data: JSON.parse(stringified) });
                            } else {
                                deletes.push(key);
                            }
                        }
                    }
                    
                    try {
                        if (upserts.length > 0) {
                            const { error } = await supabase.from('baileys_auth').upsert(upserts);
                            if (error) console.error('Error in batch upsert:', error);
                        }
                        
                        if (deletes.length > 0) {
                            const { error } = await supabase.from('baileys_auth').delete().in('id', deletes);
                            if (error) console.error('Error in batch delete:', error);
                        }
                    } catch (err) {
                        console.error('Network error during batch auth state update:', err);
                    }
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
};
