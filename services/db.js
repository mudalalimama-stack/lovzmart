import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase credentials in .env');
}

export const supabase = createClient(supabaseUrl, supabaseKey);

// --- Database Service Functions ---

/**
 * Get or create chat history for a customer
 */
export async function getChatHistory(phoneNumber) {
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('history')
    .eq('phone_number', phoneNumber)
    .single();

  if (error && error.code === 'PGRST116') { // Not found
    return [];
  }
  if (error) {
    console.error('Error fetching chat history:', error);
    return [];
  }
  return data.history || [];
}

/**
 * Save chat history for a customer
 */
export async function saveChatHistory(phoneNumber, history) {
  const { error } = await supabase
    .from('chat_sessions')
    .upsert({ 
      phone_number: phoneNumber, 
      history: history,
      updated_at: new Date().toISOString()
    });

  if (error) {
    console.error('Error saving chat history:', error);
  }
}

/**
 * Fetch products (can be used to check if items exist)
 */
export async function getProducts() {
  const { data, error } = await supabase
    .from('products')
    .select('*');
    
  if (error) {
    console.error('Error fetching products:', error);
    return [];
  }
  return data;
}

/**
 * Fetch a customer by phone number
 */
export async function getCustomerByPhone(phoneNumber) {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('phone_number', phoneNumber)
    .single();
    
  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching customer:', error);
  }
  
  return data || null;
}

/**
 * Save an order with customer details
 */
export async function createOrder(customerData, orderItemsData) {
  try {
    // 1. Upsert customer
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .upsert({
        phone_number: customerData.phone_number,
        name: customerData.name,
        address: customerData.address
      })
      .select()
      .single();

    if (customerError) throw customerError;

    // 2. Calculate total
    let totalAmount = 0;
    if (orderItemsData && orderItemsData.length > 0) {
      totalAmount = orderItemsData.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    }

    // 3. Create order
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        customer_phone: customer.phone_number,
        total_amount: totalAmount,
        status: 'pending'
      })
      .select()
      .single();

    if (orderError) throw orderError;

    // 4. Create order items (if any recognized)
    // Assuming orderItemsData is an array of { product_id, quantity, price }
    if (orderItemsData && orderItemsData.length > 0) {
      const itemsToInsert = orderItemsData.map(item => ({
        order_id: order.id,
        product_id: item.product_id,
        quantity: item.quantity,
        price_at_time: item.price
      }));

      const { error: itemsError } = await supabase
        .from('order_items')
        .insert(itemsToInsert);

      if (itemsError) throw itemsError;

      // 5. Decrement stock
      for (const item of orderItemsData) {
        const { data: productData, error: stockFetchError } = await supabase
          .from('products')
          .select('stock')
          .eq('id', item.product_id)
          .single();
          
        if (!stockFetchError && productData) {
          const newStock = Math.max(0, productData.stock - item.quantity);
          await supabase
            .from('products')
            .update({ stock: newStock })
            .eq('id', item.product_id);
        }
      }
    }

    return order;
  } catch (error) {
    console.error('Error creating order:', error);
    return null;
  }
}

/**
 * Get orders that need follow-up (2-3 days old and pending)
 */
export async function getOrdersForFollowUp() {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('orders')
    .select('id, customer_phone, status, created_at')
    .eq('status', 'pending')
    .lte('created_at', twoDaysAgo)
    .gte('created_at', threeDaysAgo);

  if (error) {
    console.error('Error fetching follow-up orders:', error);
    return [];
  }
  return data || [];
}

/**
 * Mark order as followed up
 */
export async function markOrderFollowedUp(orderId) {
  const { error } = await supabase
    .from('orders')
    .update({ status: 'followed_up' })
    .eq('id', orderId);

  if (error) {
    console.error('Error updating order status for follow-up:', error);
  }
}

/**
 * Get all customers with their order history and recent chat - for smart broadcast targeting
 */
export async function getAllCustomersWithHistory() {
  try {
    // Get all customers
    const { data: customers, error: custError } = await supabase
      .from('customers')
      .select('phone_number, name');
    if (custError) throw custError;

    // Get all orders grouped
    const { data: orders, error: ordError } = await supabase
      .from('orders')
      .select('customer_phone, status, created_at');
    if (ordError) throw ordError;

    // Get all chat sessions (last message summary)
    const { data: chats, error: chatError } = await supabase
      .from('chat_sessions')
      .select('phone_number, history');
    if (chatError) throw chatError;

    // Build enriched customer list
    const enriched = (customers || []).map(c => {
      const myOrders = (orders || []).filter(o => o.customer_phone === c.phone_number);
      const myChat = (chats || []).find(ch => ch.phone_number === c.phone_number);
      
      // Get last few chat messages as summary
      const chatSummary = myChat?.history
        ? myChat.history.slice(-6).map(h => `${h.role}: ${h.content}`).join(' | ')
        : '';

      return {
        phone_number: c.phone_number,
        name: c.name || 'Customer',
        order_count: myOrders.length,
        last_order_status: myOrders[myOrders.length - 1]?.status || 'none',
        chat_summary: chatSummary.substring(0, 500) // limit size
      };
    });

    return enriched;
  } catch (error) {
    console.error('Error fetching customers with history:', error);
    return [];
  }
}

/**
 * Save a broadcast campaign record
 */
export async function saveBroadcast(offerText, targetCount) {
  const { data, error } = await supabase
    .from('broadcasts')
    .insert({ offer_text: offerText, target_count: targetCount, status: 'sending' })
    .select()
    .single();
  if (error) {
    console.error('Error saving broadcast:', error);
    return null;
  }
  return data;
}

/**
 * Update broadcast sent count and status
 */
export async function updateBroadcastStatus(broadcastId, sentCount) {
  await supabase
    .from('broadcasts')
    .update({ sent_count: sentCount, status: 'done' })
    .eq('id', broadcastId);
}
