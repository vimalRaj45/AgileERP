const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');

const app = express();
const upload = multer();

// Cloudinary Configuration (replace with your credentials)
cloudinary.config({
    cloud_name: 'dkwdoie1i',
    api_key: '555981436359913',
    api_secret: '06JWObDdcn5jy-0mfJlfG81VvFc'
});

// Database Configuration
const pool = new Pool({
    connectionString: 'postgresql://neondb_owner:npg_BISh1YnAXj2H@ep-plain-night-adzxpk94-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
    ssl: {
        rejectUnauthorized: false // required for NeonDB
    }
});


// Session Configuration
app.use(session({
    store: new PgSession({
        pool: pool,
        tableName: 'session'
    }),
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Helper: Log activity
async function logActivity(userId, action, entityType, entityId, details = {}) {
    await pool.query(
        'INSERT INTO activity_log (user_id, action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4, $5)',
        [userId, action, entityType, entityId, details]
    );
}

// Authentication Middleware
function requireLogin(req, res, next) {
    if (!req.session.userId) {
        res.redirect('/login');
        return;
    }
    next();
}

// Serve HTML files
app.get('/', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/projects', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'projects.html'));
});

// API: Login/Logout
app.post('/api/login', async (req, res) => {
    const { username } = req.body;
    const result = await pool.query('SELECT id, username FROM users WHERE username = $1', [username]);
    
    if (result.rows.length === 0) {
        // Create user if doesn't exist (for demo purposes)
        const newUser = await pool.query(
            'INSERT INTO users (username) VALUES ($1) RETURNING id, username',
            [username]
        );
        req.session.userId = newUser.rows[0].id;
        req.session.username = newUser.rows[0].username;
    } else {
        req.session.userId = result.rows[0].id;
        req.session.username = result.rows[0].username;
    }
    
    res.json({ success: true, username: req.session.username });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// API: Current User
app.get('/api/current-user', (req, res) => {
    if (req.session.userId) {
        res.json({ 
            id: req.session.userId, 
            username: req.session.username 
        });
    } else {
        res.json({ id: null, username: null });
    }
});

// API: Projects
app.get('/api/projects', requireLogin, async (req, res) => {
    const result = await pool.query(`
        SELECT p.*, u.username as created_by_name 
        FROM projects p 
        LEFT JOIN users u ON p.created_by = u.id
        ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
});

app.post('/api/projects', requireLogin, async (req, res) => {
    const { name, description } = req.body;
    const result = await pool.query(
        'INSERT INTO projects (name, description, created_by) VALUES ($1, $2, $3) RETURNING *',
        [name, description, req.session.userId]
    );
    
    await logActivity(
        req.session.userId, 
        'create', 
        'project', 
        result.rows[0].id,
        { name, description }
    );
    
    res.json(result.rows[0]);
});

app.get('/api/projects/:id', requireLogin, async (req, res) => {
    const result = await pool.query(
        'SELECT * FROM projects WHERE id = $1',
        [req.params.id]
    );
    res.json(result.rows[0] || null);
});

// API: Meeting Notes
app.get('/api/projects/:projectId/meeting-notes', requireLogin, async (req, res) => {
    const result = await pool.query(`
    SELECT mn.*, 
           u.username AS created_by_name,
           COALESCE(
               json_agg(DISTINCT au.username) 
               FILTER (WHERE au.id IS NOT NULL), '[]'
           ) AS attendee_names
    FROM meeting_notes mn
    LEFT JOIN users u ON mn.created_by = u.id
    LEFT JOIN LATERAL jsonb_array_elements_text(mn.attendees) AS attendee(attendee_id) ON TRUE
    LEFT JOIN users au ON au.id = attendee.attendee_id::integer
    WHERE mn.project_id = $1
    GROUP BY mn.id, u.username
    ORDER BY mn.meeting_date DESC
`, [req.params.projectId]);
    res.json(result.rows);
});

app.get('/api/projects/:projectId/meeting-notes/latest', requireLogin, async (req, res) => {
   const result = await pool.query(`
    SELECT mn.*, 
           u.username AS created_by_name,
           COALESCE(
               json_agg(DISTINCT au.username) 
               FILTER (WHERE au.id IS NOT NULL), '[]'
           ) AS attendee_names
    FROM meeting_notes mn
    LEFT JOIN users u ON mn.created_by = u.id
    LEFT JOIN LATERAL jsonb_array_elements_text(mn.attendees) AS attendee(attendee_id) ON TRUE
    LEFT JOIN users au ON au.id = attendee.attendee_id::integer
    WHERE mn.project_id = $1
    GROUP BY mn.id, u.username
    ORDER BY mn.meeting_date DESC
    LIMIT 1
`, [req.params.projectId]);

    
    res.json(result.rows[0] || null);
});

app.post('/api/projects/:projectId/meeting-notes', requireLogin, async (req, res) => {
    const {
        title,
        meeting_date,
        next_meeting_date,
        attendees,
        discussion_points,
        decisions_made,
        action_items,
        notes
    } = req.body;
    
    const result = await pool.query(
        `INSERT INTO meeting_notes (
            project_id, title, meeting_date, next_meeting_date,
            attendees, discussion_points, decisions_made, action_items,
            notes, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
            req.params.projectId, title, meeting_date, next_meeting_date,
            JSON.stringify(attendees || []),
            JSON.stringify(discussion_points || []),
            JSON.stringify(decisions_made || []),
            JSON.stringify(action_items || []),
            notes, req.session.userId
        ]
    );
    
    await logActivity(
        req.session.userId,
        'create',
        'meeting',
        result.rows[0].id,
        { title, projectId: req.params.projectId }
    );
    
    res.json(result.rows[0]);
});

app.put('/api/meeting-notes/:id', requireLogin, async (req, res) => {
    const {
        title,
        meeting_date,
        next_meeting_date,
        attendees,
        discussion_points,
        decisions_made,
        action_items,
        notes
    } = req.body;
    
    const result = await pool.query(
        `UPDATE meeting_notes 
         SET title = $1, meeting_date = $2, next_meeting_date = $3,
             attendees = $4, discussion_points = $5, 
             decisions_made = $6, action_items = $7,
             notes = $8, updated_at = CURRENT_TIMESTAMP
         WHERE id = $9 AND created_by = $10 RETURNING *`,
        [
            title, meeting_date, next_meeting_date,
            JSON.stringify(attendees || []),
            JSON.stringify(discussion_points || []),
            JSON.stringify(decisions_made || []),
            JSON.stringify(action_items || []),
            notes, req.params.id, req.session.userId
        ]
    );
    
    if (result.rows.length > 0) {
        await logActivity(
            req.session.userId,
            'update',
            'meeting',
            req.params.id,
            { title }
        );
    }
    
    res.json(result.rows[0] || null);
});

app.delete('/api/meeting-notes/:id', requireLogin, async (req, res) => {
    const result = await pool.query(
        'DELETE FROM meeting_notes WHERE id = $1 AND created_by = $2',
        [req.params.id, req.session.userId]
    );
    
    if (result.rowCount > 0) {
        await logActivity(
            req.session.userId,
            'delete',
            'meeting',
            req.params.id
        );
    }
    
    res.json({ success: result.rowCount > 0 });
});


// Add to server.js routes
app.get('/meetings', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'meeting-notes.html'));
});



// API: Tasks
app.get('/api/projects/:projectId/tasks', requireLogin, async (req, res) => {
    const result = await pool.query(`
        SELECT t.*, 
               u1.username as assigned_username,
               u2.username as created_by_name
        FROM tasks t
        LEFT JOIN users u1 ON t.assigned_to = u1.id
        LEFT JOIN users u2 ON t.created_by = u2.id
        WHERE t.project_id = $1
        ORDER BY 
            CASE t.priority 
                WHEN 'High' THEN 1 
                WHEN 'Medium' THEN 2 
                WHEN 'Low' THEN 3 
                ELSE 4 
            END,
            t.created_at DESC
    `, [req.params.projectId]);
    res.json(result.rows);
});

app.post('/api/projects/:projectId/tasks', requireLogin, async (req, res) => {
    const { title, description, priority = 'Medium', assigned_to } = req.body;
    const result = await pool.query(
        `INSERT INTO tasks (title, description, priority, project_id, assigned_to, created_by) 
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [title, description, priority, req.params.projectId, assigned_to, req.session.userId]
    );
    
    await logActivity(
        req.session.userId,
        'create',
        'task',
        result.rows[0].id,
        { title, projectId: req.params.projectId }
    );
    
    res.json(result.rows[0]);
});

app.put('/api/tasks/:id', requireLogin, async (req, res) => {
    const { title, description, status, priority, assigned_to } = req.body;
    const result = await pool.query(
        `UPDATE tasks 
         SET title = $1, description = $2, status = $3, priority = $4, 
             assigned_to = $5, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $6 RETURNING *`,
        [title, description, status, priority, assigned_to, req.params.id]
    );
    
    await logActivity(
        req.session.userId,
        'update',
        'task',
        req.params.id,
        { status, title }
    );
    
    res.json(result.rows[0]);
});

app.delete('/api/tasks/:id', requireLogin, async (req, res) => {
    await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    
    await logActivity(
        req.session.userId,
        'delete',
        'task',
        req.params.id
    );
    
    res.json({ success: true });
});

// API: Comments
app.get('/api/tasks/:taskId/comments', requireLogin, async (req, res) => {
    const result = await pool.query(`
        SELECT c.*, u.username 
        FROM comments c 
        JOIN users u ON c.user_id = u.id 
        WHERE c.task_id = $1 
        ORDER BY c.created_at ASC
    `, [req.params.taskId]);
    res.json(result.rows);
});

app.post('/api/tasks/:taskId/comments', requireLogin, async (req, res) => {
    const { content } = req.body;
    const result = await pool.query(
        'INSERT INTO comments (task_id, user_id, content) VALUES ($1, $2, $3) RETURNING *',
        [req.params.taskId, req.session.userId, content]
    );
    
    await logActivity(
        req.session.userId,
        'comment',
        'task',
        req.params.taskId,
        { content: content.substring(0, 50) }
    );
    
    const commentWithUser = await pool.query(`
        SELECT c.*, u.username 
        FROM comments c 
        JOIN users u ON c.user_id = u.id 
        WHERE c.id = $1
    `, [result.rows[0].id]);
    
    res.json(commentWithUser.rows[0]);
});

// API: File Upload (Cloudinary)
app.post('/api/tasks/:taskId/files', requireLogin, upload.single('file'), async (req, res) => {
    try {
        const fileBuffer = req.file.buffer;
        const fileName = req.file.originalname;
        
        // Upload to Cloudinary
        const uploadResult = await new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
                { resource_type: 'auto' },
                (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                }
            );
            streamifier.createReadStream(fileBuffer).pipe(uploadStream);
        });
        
        // Save to database
        const result = await pool.query(
            `INSERT INTO files (task_id, user_id, filename, cloudinary_url, cloudinary_public_id) 
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [req.params.taskId, req.session.userId, fileName, uploadResult.secure_url, uploadResult.public_id]
        );
        
        await logActivity(
            req.session.userId,
            'upload',
            'file',
            result.rows[0].id,
            { filename: fileName, taskId: req.params.taskId }
        );
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

app.get('/api/tasks/:taskId/files', requireLogin, async (req, res) => {
    const result = await pool.query(`
        SELECT f.*, u.username 
        FROM files f 
        JOIN users u ON f.user_id = u.id 
        WHERE f.task_id = $1 
        ORDER BY f.uploaded_at DESC
    `, [req.params.taskId]);
    res.json(result.rows);
});

// API: Users
app.get('/api/users', requireLogin, async (req, res) => {
    const result = await pool.query('SELECT id, username FROM users ORDER BY username');
    res.json(result.rows);
});

// API: Activity/Notifications
app.get('/api/activity', requireLogin, async (req, res) => {
    const result = await pool.query(`
        SELECT a.*, u.username 
        FROM activity_log a 
        JOIN users u ON a.user_id = u.id 
        ORDER BY a.created_at DESC 
        LIMIT 50
    `);
    res.json(result.rows);
});

// API: Kanban data
app.get('/api/projects/:projectId/kanban', requireLogin, async (req, res) => {
    const result = await pool.query(`
        SELECT 
            status,
            JSON_AGG(
                JSON_BUILD_OBJECT(
                    'id', t.id,
                    'title', t.title,
                    'description', t.description,
                    'priority', t.priority,
                    'assigned_to', t.assigned_to,
                    'assigned_username', u.username,
                    'created_by_name', u2.username,
                    'created_at', t.created_at
                ) ORDER BY 
                    CASE t.priority 
                        WHEN 'High' THEN 1 
                        WHEN 'Medium' THEN 2 
                        WHEN 'Low' THEN 3 
                        ELSE 4 
                    END
            ) as tasks
        FROM tasks t
        LEFT JOIN users u ON t.assigned_to = u.id
        LEFT JOIN users u2 ON t.created_by = u2.id
        WHERE t.project_id = $1
        GROUP BY t.status
    `, [req.params.projectId]);
    
    const kanbanData = {
        'To Do': [],
        'In Progress': [],
        'Done': []
    };
    
    result.rows.forEach(row => {
        kanbanData[row.status] = row.tasks;
    });
    
    res.json(kanbanData);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Login with any username (no password required)');
});