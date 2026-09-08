const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2');
const multer = require('multer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const port = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

const db = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 28442,
    user: process.env.DB_USER || 'avnadmin',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'defaultdb',
    ssl: { rejectUnauthorized: false }
});

db.connect((err) => {
    if (err) {
        console.error('MySQL 연결 실패:', err);
        return;
    }
    console.log('MySQL 데이터베이스 연결 성공!');
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// [API] 상품 목록 조회
app.get('/api/products', (req, res) => {
    const search = req.query.search || '';
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    let countQuery = 'SELECT COUNT(*) as total FROM products WHERE name LIKE ?';
    let dataQuery = 'SELECT * FROM products WHERE name LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?';
    const searchKeyword = `%${search}%`;

    db.query(countQuery, [searchKeyword], (err, countResult) => {
        if (err) return res.status(500).send('데이터 조회 실패');
        const totalItems = countResult[0].total;
        const totalPages = Math.ceil(totalItems / limit) || 1;

        db.query(dataQuery, [searchKeyword, limit, offset], (err, results) => {
            if (err) return res.status(500).send('데이터 조회 실패');
            res.json({ products: results, currentPage: page, totalPages, totalItems });
        });
    });
});

// [API] 상품 등록 (실시간 전파 추가)
app.post('/api/products', upload.single('image'), (req, res) => {
    const { name, price, stock } = req.body;
    const image_url = req.file ? req.file.filename : null;
    const query = 'INSERT INTO products (name, price, stock, image_url) VALUES (?, ?, ?, ?)';
    db.query(query, [name, price, stock, image_url], (err) => {
        if (err) return res.status(500).send('상품 등록 실패');
        
        io.emit('productUpdated');

        res.redirect('/index.html');
    });
});

// [API] 상품 삭제 (실시간 전파 추가)
app.delete('/api/products/:id', (req, res) => {
    db.query('DELETE FROM products WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ success: false });
        
        io.emit('productUpdated');

        res.json({ success: true });
    });
});

// [API] 상품 수정 (실시간 전파 추가)
app.put('/api/products/:id', (req, res) => {
    const { name, price, stock } = req.body;
    db.query('UPDATE products SET name = ?, price = ?, stock = ? WHERE id = ?', [name, price, stock, req.params.id], (err) => {
        if (err) return res.status(500).json({ success: false });
        
        io.emit('productUpdated');

        res.json({ success: true });
    });
});

// ==========================================
// [API] 주문 및 처리 상태 관리
// ==========================================

// 1. 소비자 주문 접수 및 재고 자동 차감
app.post('/api/orders', (req, res) => {
    const { name, phone, items } = req.body; 
    
    if (!name || !phone || !items || items.length === 0) {
        return res.status(400).json({ success: false, message: '잘못된 주문 요청입니다.' });
    }

    db.beginTransaction((err) => {
        if (err) return res.status(500).json({ success: false, message: '트랜잭션 시작 실패' });

        const orderQuery = `INSERT INTO orders (name, phone, status) VALUES (?, ?, '상품대기')`;
        db.query(orderQuery, [name, phone], (orderErr, orderResult) => {
            if (orderErr) {
                return db.rollback(() => {
                    res.status(500).json({ success: false, message: '주문 저장 실패' });
                });
            }

            const orderId = orderResult.insertId;
            let processedCount = 0;
            let hasError = false;

            items.forEach(item => {
                const itemQuery = `INSERT INTO order_items (order_id, product_id, product_name, price, quantity) VALUES (?, ?, ?, ?, ?)`;
                db.query(itemQuery, [orderId, item.productId, item.name, item.price, item.quantity], (itemErr) => {
                    if (itemErr && !hasError) {
                        hasError = true;
                        return db.rollback(() => {
                            res.status(500).json({ success: false, message: '주문 상세 저장 실패' });
                        });
                    }

                    const stockQuery = `UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?`;
                    db.query(stockQuery, [item.quantity, item.productId, item.quantity], (stockErr, stockResult) => {
                        if (hasError) return;

                        if (stockErr || stockResult.affectedRows === 0) {
                            hasError = true;
                            return db.rollback(() => {
                                res.status(400).json({ success: false, message: `상품 '${item.name}'의 재고가 부족합니다.` });
                            });
                        }

                        processedCount++;
                        if (processedCount === items.length) {
                            db.commit((commitErr) => {
                                if (commitErr) {
                                    return db.rollback(() => {
                                        res.status(500).json({ success: false, message: '트랜잭션 커밋 실패' });
                                    });
                                }

                                io.emit('newOrder', { orderId, name, phone, items, status: '상품대기' });
                                io.emit('productUpdated');

                                res.json({ success: true, orderId, message: '주문이 완료되었습니다.' });
                            });
                        }
                    });
                });
            });
        });
    });
});

// 2. 관리자용 주문 목록 및 상세 조회 API
app.get('/api/orders', (req, res) => {
    const statusFilter = req.query.status;
    
    let query = `SELECT * FROM orders`;
    let params = [];

    if (statusFilter && statusFilter !== '전체') {
        query += ` WHERE status = ?`;
        params.push(statusFilter);
    }
    query += ` ORDER BY created_at DESC`;

    db.query(query, params, (err, orders) => {
        if (err) return res.status(500).json({ success: false, message: '주문 목록 조회 실패' });
        
        if (orders.length === 0) {
            return res.json({ success: true, orders: [] });
        }

        const orderIds = orders.map(o => o.id);
        db.query(`SELECT * FROM order_items WHERE order_id IN (?)`, [orderIds], (itemErr, items) => {
            if (itemErr) return res.status(500).json({ success: false, message: '주문 상세 조회 실패' });

            const detailedOrders = orders.map(order => ({
                ...order,
                items: items.filter(item => item.order_id === order.id)
            }));

            res.json({ success: true, orders: detailedOrders });
        });
    });
});

// 3. 주문 상태 변경 API
app.put('/api/orders/:id/status', (req, res) => {
    const orderId = req.params.id;
    const { status } = req.body;

    db.query(`UPDATE orders SET status = ? WHERE id = ?`, [status, orderId], (err) => {
        if (err) return res.status(500).json({ success: false, message: '상태 변경 실패' });
        
        io.emit('orderStatusChanged', { orderId, status });
        res.json({ success: true });
    });
});

// 4. 주문 상태 일괄 변경 API (프론트엔드 일괄 처리 연동을 위해 추가됨)
app.put('/api/orders/batch', (req, res) => {
    const { ids, status } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0 || !status) {
        return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    }

    db.query(`UPDATE orders SET status = ? WHERE id IN (?)`, [status, ids], (err) => {
        if (err) return res.status(500).json({ success: false, message: '일괄 상태 변경 실패' });
        
        io.emit('orderStatusChanged', { ids, status });
        res.json({ success: true });
    });
});

// ==========================================
// [Socket.IO] 실시간 채팅 및 소켓 이벤트 처리
// ==========================================
io.on('connection', (socket) => {
    console.log(`사용자 접속: ${socket.id}`);

    db.query('SELECT * FROM chats ORDER BY id ASC', (err, results) => {
        if (!err) {
            socket.emit('loadHistory', results);
        }
    });

    socket.on('joinChat', (nickname) => {
        socket.nickname = nickname || '익명고객';
        const enterMsg = `"${socket.nickname}"님이 입장했습니다.`;
        
        io.emit('receiveMessage', {
            sender: '안내',
            text: enterMsg,
            type: 'system'
        });
    });

    socket.on('loadHistory', () => {
        const query = `
            SELECT * FROM (
                SELECT * FROM chats ORDER BY id DESC LIMIT 100
            ) sub ORDER BY id ASC
        `;
        
        db.query(query, (err, results) => {
            if (err) {
                console.error('채팅 기록 불러오기 실패:', err);
                return;
            }
            socket.emit('loadHistory', results);
        });
    });

    socket.on('sendMessage', (data) => {
        let senderName = '';
        let senderRole = '';

        if (data.role === 'admin') {
            senderName = '관리자';
            senderRole = 'admin';
        } else {
            senderName = data.nickname || '익명고객';
            senderRole = 'customer';
        }

        const messageData = {
            sender: senderName,
            message: data.text,
            role: senderRole
        };

        db.query('INSERT INTO chats (sender, message, role) VALUES (?, ?, ?)', 
            [messageData.sender, messageData.message, messageData.role], 
            (err) => {
                if (err) console.error('채팅 저장 실패:', err);
                
                io.emit('receiveMessage', {
                    sender: messageData.sender,
                    text: messageData.message,
                    role: messageData.role
                });
            }
        );
    });

    socket.on('adminChangeStatus', (isEditable) => {
        io.emit('statusUpdated', isEditable);
    });

    socket.on('disconnect', () => {
        if (socket.nickname) {
            io.emit('receiveMessage', {
                sender: '안내',
                text: `"${socket.nickname}"님이 퇴장했습니다.`,
                type: 'system'
            });
        }
        console.log(`연결 해제: ${socket.id}`);
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'customer.html'));
});

server.listen(port, '0.0.0.0', () => {
    console.log(`서버가 http://localhost:${port} 에서 실행중입니다.`);
});

// ==========================================
// 1. 소비자가 자신의 주문 목록 조회
// ==========================================
app.get('/api/my-orders', (req, res) => {
    const { name, phone } = req.query;
    if (!name || !phone) {
        return res.status(400).json({ success: false, message: '이름과 휴대폰 번호를 모두 입력해주세요.' });
    }

    const query = `SELECT * FROM orders WHERE name = ? AND phone = ? ORDER BY created_at DESC`;
    db.query(query, [name, phone], (err, orders) => {
        if (err) {
            console.error('주문 조회 DB 오류:', err);
            return res.status(500).json({ success: false, message: '주문 조회 실패' });
        }
        if (orders.length === 0) return res.json({ success: true, orders: [] });

        const orderIds = orders.map(o => o.id);
        
        db.query(`SELECT * FROM order_items WHERE order_id IN (?)`, [orderIds], (itemErr, items) => {
            if (itemErr) {
                console.error('주문 상세 조회 DB 오류:', itemErr);
                return res.status(500).json({ success: false, message: '주문 상세 조회 실패' });
            }

            const detailedOrders = orders.map(order => ({
                ...order,
                items: items.filter(item => item.order_id === order.id)
            }));

            res.json({ success: true, orders: detailedOrders });
        });
    });
});

// ==========================================
// 2. 주문 취소 (삭제) 및 재고 원복
// ==========================================
app.delete('/api/orders/:id', (req, res) => {
    const orderId = req.params.id;

    db.query(`SELECT * FROM orders WHERE id = ?`, [orderId], (err, orders) => {
        if (err || orders.length === 0) return res.status(404).json({ success: false, message: '주문을 찾을 수 없습니다.' });
        
        const order = orders[0];
        if (order.status !== '상품대기') {
            return res.status(400).json({ success: false, message: '이미 상품 준비가 시작되어 취소할 수 없습니다.' });
        }

        db.query(`SELECT * FROM order_items WHERE order_id = ?`, [orderId], (itemErr, items) => {
            if (itemErr) return res.status(500).json({ success: false, message: '주문 상품 조회 실패' });

            db.beginTransaction((transErr) => {
                if (transErr) return res.status(500).json({ success: false, message: '트랜잭션 시작 실패' });

                let processed = 0;
                let hasError = false;

                items.forEach(item => {
                    db.query(`UPDATE products SET stock = stock + ? WHERE id = ?`, [item.quantity, item.product_id], (stockErr) => {
                        if (stockErr && !hasError) {
                            hasError = true;
                            return db.rollback(() => res.status(500).json({ success: false, message: '재고 원복 실패' }));
                        }
                        processed++;
                        if (processed === items.length) {
                            db.query(`DELETE FROM order_items WHERE order_id = ?`, [orderId], (delItemErr) => {
                                if (hasError) return;
                                if (delItemErr) {
                                    return db.rollback(() => res.status(500).json({ success: false, message: '주문 상세 삭제 실패' }));
                                }

                                db.query(`DELETE FROM orders WHERE id = ?`, [orderId], (delOrderErr) => {
                                    if (delOrderErr) {
                                        return db.rollback(() => res.status(500).json({ success: false, message: '주문 삭제 실패' }));
                                    }

                                    db.commit((commitErr) => {
                                        if (commitErr) {
                                            return db.rollback(() => res.status(500).json({ success: false, message: '커밋 실패' }));
                                        }
                                        io.emit('orderStatusChanged', { orderId, status: '삭제됨' });
                                        io.emit('productUpdated');

                                        res.json({ success: true, message: '주문이 취소되었습니다.' });
                                    });
                                });
                            });
                        }
                    });
                });
            });
        });
    });
});