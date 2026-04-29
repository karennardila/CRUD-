const express = require('express');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const mongoUrl = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'crud_db';
const client = new MongoClient(mongoUrl);

let usuariosCollection;
let usingMemoryStore = false;
const memoryUsuarios = [];
const sseClientes = new Set();

function notificarCambioUsuarios() {
  for (const res of sseClientes) {
    res.write('data: {}\n\n');
  }
}

function escaparRegex(texto) {
  return String(texto).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Evita que _id llegue como { $oid } al navegador y rompa edición/eliminación. */
function idAString(id) {
  if (id == null) return '';
  if (typeof id === 'string') return id;
  if (typeof id === 'object' && id !== null && typeof id.$oid === 'string') return id.$oid;
  if (typeof id === 'object' && id !== null && typeof id.toString === 'function') {
    const s = id.toString();
    if (/^[a-f0-9]{24}$/i.test(s)) return s;
  }
  return String(id);
}

function usuarioParaJson(doc) {
  if (!doc) return doc;
  return { ...doc, _id: idAString(doc._id) };
}

function validarDatosUsuario(body) {
  const { nombre, tipoIdentificacion, numeroIdentificacion, email, edad, telefono } = body;
  const edadNumero = Number(edad);

  if (!nombre || !tipoIdentificacion || !numeroIdentificacion || !email || !telefono || Number.isNaN(edadNumero)) {
    return { valido: false, error: 'Por favor completa todos los campos.' };
  }

  return {
    valido: true,
    usuario: {
      nombre,
      tipoIdentificacion,
      numeroIdentificacion,
      email,
      edad: edadNumero,
      telefono
    }
  };
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'formulario.html'));
});

app.get('/eventos', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseClientes.add(res);
  res.write('data: {}\n\n');

  req.on('close', () => {
    sseClientes.delete(res);
  });
});

app.get('/estado-nodo', async (req, res) => {
  if (usingMemoryStore) {
    return res.json({
      success: true,
      modo: 'respaldo',
      nodo: 'sin MongoDB (memoria)'
    });
  }

  try {
    const adminDb = client.db('admin');
    const hello = await adminDb.command({ hello: 1 });
    const primary = hello.primary || 'desconocido';

    return res.json({
      success: true,
      modo: 'replicaset',
      nodo: primary
    });
  } catch (err) {
    console.error('Error consultando estado del nodo:', err);
    return res.status(500).json({
      success: false,
      message: 'No se pudo consultar el estado del nodo.'
    });
  }
});

app.post('/usuarios', async (req, res) => {
  const validacion = validarDatosUsuario(req.body);
  if (!validacion.valido) {
    return res.status(400).json({ success: false, message: validacion.error });
  }
  const usuario = validacion.usuario;

  try {
    const result = await usuariosCollection.insertOne(usuario);
    notificarCambioUsuarios();
    return res.json({ success: true, id: idAString(result.insertedId) });
  } catch (err) {
    console.error('Error insertando usuario:', err);
    return res.status(500).json({ success: false, message: 'Error al guardar en la base de datos.' });
  }
});

app.get('/usuarios', async (req, res) => {
  const termino = (req.query.q || '').toString().trim();

  try {
    let usuarios;

    if (usingMemoryStore) {
      usuarios = await usuariosCollection.find({}).toArray();
      if (termino) {
        const terminoMin = termino.toLowerCase();
        usuarios = usuarios.filter((usuario) => (
          (usuario.nombre || '').toLowerCase().includes(terminoMin) ||
          (usuario.numeroIdentificacion || '').toLowerCase().includes(terminoMin) ||
          (usuario.email || '').toLowerCase().includes(terminoMin) ||
          (usuario.telefono || '').toLowerCase().includes(terminoMin)
        ));
      }
    } else {
      const filtro = termino
        ? {
            $or: [
              { nombre: { $regex: escaparRegex(termino), $options: 'i' } },
              { numeroIdentificacion: { $regex: escaparRegex(termino), $options: 'i' } },
              { email: { $regex: escaparRegex(termino), $options: 'i' } },
              { telefono: { $regex: escaparRegex(termino), $options: 'i' } }
            ]
          }
        : {};
      usuarios = await usuariosCollection.find(filtro).toArray();
    }

    res.json(usuarios.map(usuarioParaJson));
  } catch (err) {
    console.error('Error obteniendo usuarios:', err);
    res.status(500).json({ error: 'Error al leer la base de datos.' });
  }
});

app.put('/usuarios/:id', async (req, res) => {
  const { id } = req.params;
  const validacion = validarDatosUsuario(req.body);
  if (!validacion.valido) {
    return res.status(400).json({ success: false, message: validacion.error });
  }

  try {
    let result;

    if (usingMemoryStore) {
      const index = memoryUsuarios.findIndex((u) => String(u._id) === id);
      if (index === -1) {
        return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
      }
      memoryUsuarios[index] = { ...memoryUsuarios[index], ...validacion.usuario };
      result = { matchedCount: 1, modifiedCount: 1 };
    } else {
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: 'ID inválido.' });
      }
      result = await usuariosCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: validacion.usuario }
      );
    }

    if (!result.matchedCount) {
      return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
    }

    notificarCambioUsuarios();
    return res.json({ success: true, message: 'Usuario actualizado correctamente.' });
  } catch (err) {
    console.error('Error actualizando usuario:', err);
    return res.status(500).json({ success: false, message: 'Error al actualizar en la base de datos.' });
  }
});

app.delete('/usuarios/:id', async (req, res) => {
  const { id } = req.params;

  try {
    let result;

    if (usingMemoryStore) {
      const index = memoryUsuarios.findIndex((u) => String(u._id) === id);
      if (index === -1) {
        return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
      }
      memoryUsuarios.splice(index, 1);
      result = { deletedCount: 1 };
    } else {
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: 'ID inválido.' });
      }
      result = await usuariosCollection.deleteOne({ _id: new ObjectId(id) });
    }

    if (!result.deletedCount) {
      return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
    }

    notificarCambioUsuarios();
    return res.json({ success: true, message: 'Usuario eliminado correctamente.' });
  } catch (err) {
    console.error('Error eliminando usuario:', err);
    return res.status(500).json({ success: false, message: 'Error al eliminar en la base de datos.' });
  }
});

async function main() {
  try {
    await client.connect();
    const db = client.db(dbName);
    usuariosCollection = db.collection('usuarios');
  } catch (err) {
    console.error('Error conectando a MongoDB:', err);
    console.warn('Iniciando en modo local sin MongoDB (datos temporales en memoria).');
    usingMemoryStore = true;
    usuariosCollection = {
      async insertOne(usuario) {
        const insertedId = memoryUsuarios.length + 1;
        memoryUsuarios.push({ _id: insertedId, ...usuario });
        return { insertedId };
      },
      find() {
        return {
          async toArray() {
            return memoryUsuarios;
          }
        };
      }
    };
  }

  app.listen(port, 'localhost', () => {
    console.log(`Servidor iniciado en http://localhost:${port}`);
    if (usingMemoryStore) {
      console.log('Modo de respaldo activo: sin conexión a MongoDB.');
    } else {
      console.log('Conectado a MongoDB en', mongoUrl);
    }
  });
}

process.on('SIGINT', async () => {
  if (!usingMemoryStore) {
    await client.close();
    console.log('Conexión a MongoDB cerrada');
  }
  process.exit(0);
});

main();
