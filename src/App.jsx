import React, { useState, useEffect, useRef, useCallback } from 'react';
import { User, Cpu, Play, RotateCcw, Home, Trophy, Swords, Globe, Copy, Users } from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, doc, setDoc, getDoc, onSnapshot, updateDoc } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyCHHkzgSAgBf-ShDFX5qv1lCgodBD0D_lE",
  authDomain: "gomoku-game-ebf1b.firebaseapp.com",
  projectId: "gomoku-game-ebf1b",
  storageBucket: "gomoku-game-ebf1b.firebasestorage.app",
  messagingSenderId: "809821256082",
  appId: "1:809821256082:web:07e6b219816f61b116294b",
  measurementId: "G-CK43ZYSGJP"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

let app, auth, db, globalAppId;


const BOARD_SIZE = 15;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

// --- AI 評分邏輯 (保留單機模式使用) ---
const getShapeScore = (count, openEnds) => {
  if (count >= 5) return 10000000;
  if (count === 4) return openEnds === 2 ? 100000 : 10000;
  if (count === 3) return openEnds === 2 ? 10000 : 1000;
  if (count === 2) return openEnds === 2 ? 100 : 10;
  return 0;
};

const evaluateDirections = (boardState, r, c, player) => {
  let total = 0;
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (let [dr, dc] of dirs) {
    let count = 1; let openEnds = 0;
    let i = 1;
    while (true) {
      const nr = r + dr * i, nc = c + dc * i;
      if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) break;
      if (boardState[nr][nc] === player) count++;
      else if (boardState[nr][nc] === EMPTY) { openEnds++; break; }
      else break; i++;
    }
    i = 1;
    while (true) {
      const nr = r - dr * i, nc = c - dc * i;
      if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) break;
      if (boardState[nr][nc] === player) count++;
      else if (boardState[nr][nc] === EMPTY) { openEnds++; break; }
      else break; i++;
    }
    total += getShapeScore(count, openEnds);
  }
  return total;
};

const evaluateCellForAI = (boardState, r, c) => {
  const aiScore = evaluateDirections(boardState, r, c, WHITE);
  const playerScore = evaluateDirections(boardState, r, c, BLACK);
  return aiScore * 1.1 + playerScore; 
};

export default function App() {
  const [user, setUser] = useState(null);
  const [gameState, setGameState] = useState('menu'); // menu, playing, room_setup
  const [mode, setMode] = useState('pvc'); // pvp, pvc, online
  const [difficulty, setDifficulty] = useState('medium');
  
  // 遊戲狀態
  const [board, setBoard] = useState(Array(BOARD_SIZE).fill().map(() => Array(BOARD_SIZE).fill(EMPTY)));
  const [currentPlayer, setCurrentPlayer] = useState(BLACK);
  const [winner, setWinner] = useState(null);
  const [winningLine, setWinningLine] = useState([]);
  const [lastMove, setLastMove] = useState(null);
  
  // 連線狀態
  const [roomId, setRoomId] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [roomStatus, setRoomStatus] = useState(''); // waiting, playing
  const [myColor, setMyColor] = useState(null);
  const [joinError, setJoinError] = useState('');
  const [copied, setCopied] = useState(false);

  const boardRef = useRef(board);
  useEffect(() => { boardRef.current = board; }, [board]);

  // --- Firebase 登入 ---
  useEffect(() => {
    if (!auth) return;
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (error) { console.error("Auth error", error); }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  // --- 線上房間同步監聽 ---
  useEffect(() => {
    if (mode !== 'online' || !roomId || !user || !db) return;
    const roomRef = doc(db, 'artifacts', globalAppId, 'public', 'data', 'rooms', roomId);
    
    const unsubscribe = onSnapshot(roomRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data.board) setBoard(JSON.parse(data.board));
        if (data.currentPlayer) setCurrentPlayer(data.currentPlayer);
        if (data.winner !== undefined) setWinner(data.winner);
        if (data.winningLine) setWinningLine(JSON.parse(data.winningLine));
        if (data.lastMove) setLastMove(JSON.parse(data.lastMove));
        if (data.status) setRoomStatus(data.status);
      }
    }, (error) => console.error("Sync error", error));
    return () => unsubscribe();
  }, [mode, roomId, user]);

  const checkWin = useCallback((currentBoard, r, c, player) => {
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (let [dr, dc] of dirs) {
      let count = 1;
      const line = [{ r, c }];
      let i = 1;
      while (true) {
        const nr = r + dr * i, nc = c + dc * i;
        if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && currentBoard[nr][nc] === player) {
          count++; line.push({ r: nr, c: nc });
        } else break; i++;
      }
      i = 1;
      while (true) {
        const nr = r - dr * i, nc = c - dc * i;
        if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && currentBoard[nr][nc] === player) {
          count++; line.push({ r: nr, c: nc });
        } else break; i++;
      }
      if (count >= 5) return line;
    }
    return null;
  }, []);

  // --- 建立連線房間 ---
  const createRoom = async () => {
    if (!user || !db) return;
    const newRoomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    const roomRef = doc(db, 'artifacts', globalAppId, 'public', 'data', 'rooms', newRoomId);
    
    const initialBoard = Array(BOARD_SIZE).fill().map(() => Array(BOARD_SIZE).fill(EMPTY));
    await setDoc(roomRef, {
      board: JSON.stringify(initialBoard),
      currentPlayer: BLACK,
      winner: null,
      winningLine: null,
      lastMove: null,
      players: { black: user.uid, white: null },
      status: 'waiting',
      createdAt: Date.now()
    });
    
    setRoomId(newRoomId);
    setMyColor(BLACK);
    setMode('online');
    setRoomStatus('waiting');
    setGameState('playing');
  };

  // --- 加入連線房間 ---
  const joinRoom = async () => {
    if (!user || !joinCode || !db) return;
    const code = joinCode.toUpperCase();
    setJoinError('');
    
    try {
      const roomRef = doc(db, 'artifacts', globalAppId, 'public', 'data', 'rooms', code);
      const docSnap = await getDoc(roomRef);
      
      if (docSnap.exists()) {
         const data = docSnap.data();
         if (data.players.white && data.players.white !== user.uid && data.players.black !== user.uid) {
            setJoinError("該房間已滿！");
            return;
         }
         
         await updateDoc(roomRef, {
           'players.white': user.uid,
           status: 'playing'
         });
         
         setRoomId(code);
         setMyColor(WHITE);
         setMode('online');
         setRoomStatus('playing');
         setGameState('playing');
      } else {
         setJoinError("找不到該房間！請確認代碼。");
      }
    } catch(e) {
      setJoinError("連線錯誤。");
    }
  };

  const copyRoomId = () => {
    navigator.clipboard.writeText(roomId)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })
      .catch(() => {
        const textArea = document.createElement("textarea");
        textArea.value = roomId;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
        setCopied(true); setTimeout(() => setCopied(false), 2000);
      });
  };

  // --- 處理落子 (支援單機與連線) ---
  const handleMove = useCallback(async (r, c, player) => {
    if (winner || boardRef.current[r][c] !== EMPTY) return;

    const newBoard = boardRef.current.map(row => [...row]);
    newBoard[r][c] = player;
    
    const winLine = checkWin(newBoard, r, c, player);
    let nextWinner = null;
    let nextPlayer = player === BLACK ? WHITE : BLACK;

    if (winLine) nextWinner = player;
    else if (newBoard.every(row => row.every(cell => cell !== EMPTY))) nextWinner = 'draw';

    // 更新本地狀態 (讓 UI 立即反應)
    setBoard(newBoard);
    setLastMove({ r, c });
    if (nextWinner) {
      setWinner(nextWinner);
      setWinningLine(winLine || []);
    } else {
      setCurrentPlayer(nextPlayer);
    }

    // 若為連線模式，更新 Firebase
    if (mode === 'online' && roomId && db) {
      try {
        const roomRef = doc(db, 'artifacts', globalAppId, 'public', 'data', 'rooms', roomId);
        await updateDoc(roomRef, {
          board: JSON.stringify(newBoard),
          currentPlayer: nextWinner ? player : nextPlayer,
          winner: nextWinner,
          winningLine: winLine ? JSON.stringify(winLine) : null,
          lastMove: JSON.stringify({ r, c }),
          updatedAt: Date.now()
        });
      } catch (e) {
        console.error("Failed to update move", e);
      }
    }
  }, [winner, checkWin, mode, roomId]);

  // 單機模式電腦 AI
  const calculateAIMove = useCallback((currentBoard, diff) => {
    const emptyCells = [];
    let hasStones = false;
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (currentBoard[r][c] !== EMPTY) hasStones = true;
        else emptyCells.push({ r, c });
      }
    }
    if (!hasStones) return { r: Math.floor(BOARD_SIZE / 2), c: Math.floor(BOARD_SIZE / 2) };
    if (diff === 'easy') return emptyCells[Math.floor(Math.random() * emptyCells.length)];

    let bestScore = -Infinity;
    let bestMoves = [];
    for (let { r, c } of emptyCells) {
      let score = evaluateCellForAI(currentBoard, r, c);
      if (diff === 'medium') score += Math.random() * 8000; 
      if (score > bestScore) { bestScore = score; bestMoves = [{ r, c }]; } 
      else if (score === bestScore) { bestMoves.push({ r, c }); }
    }
    return bestMoves[Math.floor(Math.random() * bestMoves.length)];
  }, []);

  useEffect(() => {
    if (gameState === 'playing' && mode === 'pvc' && currentPlayer === WHITE && !winner) {
      const timer = setTimeout(() => {
        const move = calculateAIMove(boardRef.current, difficulty);
        if (move) handleMove(move.r, move.c, WHITE);
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [currentPlayer, gameState, mode, winner, difficulty, calculateAIMove, handleMove]);

  const onCellClick = (r, c) => {
    if (winner || board[r][c] !== EMPTY) return;
    if (mode === 'pvc' && currentPlayer === WHITE) return;
    
    // 連線模式防呆：必須是自己的回合且房間為 playing
    if (mode === 'online') {
      if (roomStatus !== 'playing') return;
      if (currentPlayer !== myColor) return; 
    }
    
    handleMove(r, c, currentPlayer);
  };

  const startLocalGame = () => {
    setBoard(Array(BOARD_SIZE).fill().map(() => Array(BOARD_SIZE).fill(EMPTY)));
    setCurrentPlayer(BLACK);
    setWinner(null);
    setWinningLine([]);
    setLastMove(null);
    setGameState('playing');
  };

  const backToMenu = () => {
    setGameState('menu');
    setRoomId('');
    setJoinCode('');
  };

  const Cell = ({ r, c, value }) => {
    const isTop = r === 0, isBottom = r === BOARD_SIZE - 1;
    const isLeft = c === 0, isRight = c === BOARD_SIZE - 1;
    const isWinningCell = winningLine.some(pos => pos.r === r && pos.c === c);
    const isLast = lastMove && lastMove.r === r && lastMove.c === c;
    const isStarPoint = ([3, 11].includes(r) && [3, 11].includes(c)) || (r === 7 && c === 7);

    // 判斷是否能顯示 hover 效果
    const canHover = value === EMPTY && !winner && (
      mode === 'pvp' || 
      (mode === 'pvc' && currentPlayer === BLACK) ||
      (mode === 'online' && roomStatus === 'playing' && currentPlayer === myColor)
    );

    return (
      <div className="relative w-full aspect-square cursor-pointer flex items-center justify-center group" onClick={() => onCellClick(r, c)}>
        <div className={`absolute bg-slate-800 w-[1.5px] ${isTop ? 'top-[50%] h-[50%]' : isBottom ? 'top-0 h-[50%]' : 'top-0 h-full'}`} />
        <div className={`absolute bg-slate-800 h-[1.5px] ${isLeft ? 'left-[50%] w-[50%]' : isRight ? 'left-0 w-[50%]' : 'left-0 w-full'}`} />
        {isStarPoint && <div className="absolute w-2 h-2 bg-slate-800 rounded-full z-0" />}
        {value !== EMPTY && (
          <div className={`relative z-10 w-[80%] h-[80%] rounded-full shadow-md transition-all duration-300
            ${value === BLACK ? 'bg-gradient-to-br from-gray-700 to-black' : 'bg-gradient-to-br from-white to-gray-300'}
            ${isWinningCell ? 'ring-4 ring-rose-500 animate-pulse' : ''}
          `}>
            {isLast && !isWinningCell && <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-2 h-2 bg-red-500 rounded-full" />}
          </div>
        )}
        {canHover && <div className="absolute z-10 w-[80%] h-[80%] rounded-full bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity duration-200" />}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center font-sans text-slate-800 p-4">
      {gameState === 'menu' && (
        <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md flex flex-col items-center space-y-8 animate-in fade-in zoom-in">
          <div className="text-center space-y-2">
            <h1 className="text-4xl font-bold text-slate-900 tracking-wider">五子棋</h1>
            <p className="text-slate-500">選擇你想遊玩的模式</p>
          </div>

          <div className="w-full space-y-4">
            <button onClick={() => { setMode('pvc'); setGameState('room_setup'); }} className="w-full flex items-center p-4 rounded-xl border-2 border-slate-200 hover:border-indigo-500 hover:bg-indigo-50 transition-all text-left">
              <Cpu className="text-indigo-600 mr-4" size={28} />
              <div><p className="font-bold text-slate-800">單人遊戲</p><p className="text-xs text-slate-500">與電腦對戰 (本機)</p></div>
            </button>
            <button onClick={() => { setMode('pvp'); startLocalGame(); }} className="w-full flex items-center p-4 rounded-xl border-2 border-slate-200 hover:border-indigo-500 hover:bg-indigo-50 transition-all text-left">
              <Users className="text-indigo-600 mr-4" size={28} />
              <div><p className="font-bold text-slate-800">雙人遊戲</p><p className="text-xs text-slate-500">同螢幕輪流對戰</p></div>
            </button>
            <button onClick={() => { setMode('online'); setGameState('room_setup'); }} className="w-full flex items-center p-4 rounded-xl border-2 border-slate-200 hover:border-rose-500 hover:bg-rose-50 transition-all text-left">
              <Globe className="text-rose-600 mr-4" size={28} />
              <div><p className="font-bold text-slate-800">連線對戰</p><p className="text-xs text-slate-500">與遠端朋友一起玩</p></div>
            </button>
          </div>
        </div>
      )}

      {gameState === 'room_setup' && mode === 'pvc' && (
        <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md animate-in slide-in-from-bottom-4">
          <h2 className="text-2xl font-bold text-center mb-6">選擇難度</h2>
          <div className="space-y-3 mb-8">
            {['easy', 'medium', 'hard'].map((level) => (
              <button key={level} onClick={() => setDifficulty(level)} className={`w-full py-3 rounded-xl border-2 transition-all font-medium ${difficulty === level ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600'}`}>
                {level === 'easy' ? '簡單 (適合新手)' : level === 'medium' ? '中等 (有點挑戰)' : '困難 (AI 高手)'}
              </button>
            ))}
          </div>
          <div className="flex space-x-3">
            <button onClick={backToMenu} className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-bold">返回</button>
            <button onClick={startLocalGame} className="flex-[2] py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold shadow-lg shadow-indigo-200">開始遊戲</button>
          </div>
        </div>
      )}

      {gameState === 'room_setup' && mode === 'online' && (
        <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md animate-in slide-in-from-bottom-4 space-y-6">
          <div className="text-center">
             <h2 className="text-2xl font-bold mb-2">線上對戰</h2>
             <p className="text-sm text-slate-500">建立房間邀請朋友，或輸入代碼加入。</p>
          </div>
          
          <button onClick={createRoom} className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold shadow-lg flex items-center justify-center">
            <Swords className="mr-2" size={20} /> 建立新房間
          </button>
          
          <div className="relative flex py-2 items-center">
            <div className="flex-grow border-t border-slate-200"></div>
            <span className="flex-shrink-0 mx-4 text-slate-400 text-sm">或</span>
            <div className="flex-grow border-t border-slate-200"></div>
          </div>

          <div className="space-y-3">
             <input type="text" maxLength={5} placeholder="輸入 5 碼房間代碼" value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} className="w-full p-4 border-2 border-slate-200 rounded-xl text-center text-xl font-bold tracking-[0.5em] focus:border-indigo-500 focus:outline-none uppercase" />
             {joinError && <p className="text-rose-500 text-sm text-center">{joinError}</p>}
             <button onClick={joinRoom} disabled={joinCode.length !== 5} className="w-full py-4 bg-slate-800 hover:bg-slate-900 text-white rounded-xl font-bold disabled:opacity-50 transition-opacity">加入房間</button>
          </div>
          <button onClick={backToMenu} className="w-full py-3 text-slate-500 hover:bg-slate-50 rounded-xl font-bold">返回主選單</button>
        </div>
      )}

      {gameState === 'playing' && (
        <div className="w-full max-w-2xl flex flex-col items-center animate-in fade-in">
          {/* 線上模式狀態列 */}
          {mode === 'online' && (
            <div className="w-full mb-4 bg-indigo-50 border border-indigo-100 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-between shadow-sm">
              <div className="flex items-center mb-2 sm:mb-0">
                 <span className="text-indigo-900 font-medium mr-2">房間代碼:</span>
                 <span className="bg-white px-3 py-1 rounded-md border border-indigo-200 font-mono font-bold tracking-widest text-indigo-700">{roomId}</span>
                 <button onClick={copyRoomId} className="ml-2 p-1.5 text-indigo-500 hover:bg-indigo-100 rounded-md transition-colors" title="複製代碼">
                   {copied ? <span className="text-xs font-bold text-green-600">已複製</span> : <Copy size={16} />}
                 </button>
              </div>
              <div className="text-sm font-bold">
                 {roomStatus === 'waiting' ? (
                   <span className="text-amber-600 flex items-center animate-pulse"><Globe size={14} className="mr-1" /> 等待對手加入...</span>
                 ) : (
                   <span className={currentPlayer === myColor ? 'text-green-600' : 'text-slate-500'}>
                     {winner ? '遊戲結束' : (currentPlayer === myColor ? '🟢 輪到你了！' : '🟡 對手思考中...')}
                   </span>
                 )}
              </div>
            </div>
          )}

          <div className="w-full flex items-center justify-between bg-white px-6 py-4 rounded-2xl shadow-sm mb-6">
            <button onClick={backToMenu} className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg">
              <Home size={24} />
            </button>
            
            <div className="flex items-center space-x-4">
              <div className={`flex items-center space-x-2 px-4 py-2 rounded-full transition-colors ${currentPlayer === BLACK ? 'bg-slate-100 shadow-inner' : 'opacity-50'}`}>
                <div className="w-4 h-4 bg-black rounded-full shadow-sm" />
                <span className="font-bold text-slate-700">黑子 {mode === 'online' && myColor === BLACK ? '(你)' : ''}</span>
              </div>
              <span className="text-slate-300 font-bold">VS</span>
              <div className={`flex items-center space-x-2 px-4 py-2 rounded-full transition-colors ${currentPlayer === WHITE ? 'bg-slate-100 shadow-inner' : 'opacity-50'}`}>
                <div className="w-4 h-4 bg-white border border-slate-300 rounded-full shadow-sm" />
                <span className="font-bold text-slate-700">白子 {mode === 'online' && myColor === WHITE ? '(你)' : (mode === 'pvc' ? '(電腦)' : '')}</span>
              </div>
            </div>

            {mode !== 'online' ? (
              <button onClick={startLocalGame} className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg">
                <RotateCcw size={24} />
              </button>
            ) : <div className="w-10"></div>}
          </div>

          <div className={`p-2 md:p-4 bg-[#dcb35c] rounded-md shadow-2xl w-full max-w-[100vw] sm:max-w-[500px] lg:max-w-[600px] transition-opacity ${mode === 'online' && roomStatus === 'waiting' ? 'opacity-50 pointer-events-none' : ''}`}>
            <div className="grid" style={{ gridTemplateColumns: `repeat(${BOARD_SIZE}, minmax(0, 1fr))` }}>
              {board.map((row, r) => row.map((cell, c) => <Cell key={`${r}-${c}`} r={r} c={c} value={cell} />))}
            </div>
          </div>

          {winner && (
            <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-in fade-in">
              <div className="bg-white p-8 rounded-3xl shadow-2xl flex flex-col items-center max-w-sm w-full animate-in zoom-in-95">
                <div className="w-16 h-16 bg-amber-100 text-amber-500 rounded-full flex items-center justify-center mb-4"><Trophy size={32} /></div>
                <h2 className="text-3xl font-bold text-slate-800 mb-2">
                  {winner === 'draw' ? '遊戲平手！' : winner === BLACK ? '黑子獲勝！' : '白子獲勝！'}
                </h2>
                <p className="text-slate-500 mb-8 text-center">
                  {winner !== 'draw' && mode === 'online' 
                    ? (winner === myColor ? '恭喜你贏得這場連線對局！' : '很遺憾，你輸了。') 
                    : (mode === 'pvc' ? (winner === BLACK ? '你擊敗了電腦！' : '電腦贏了。') : '精彩的對決！')}
                </p>
                
                <div className="w-full space-y-3">
                  {mode !== 'online' && (
                    <button onClick={startLocalGame} className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold">再來一局</button>
                  )}
                  <button onClick={backToMenu} className="w-full py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-bold">回主選單</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
