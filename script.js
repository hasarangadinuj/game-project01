let gameOver = false;

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

//player (dino)
let dino = {
    x: 50,
    y: 200,
    width: 40,
    height: 40,
    velocityY: 0,
    jumping: false 
};

const gravity = 0.8;

//jumping logic
document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !dino.jumping) {
        dino.velocityY = -15;
        dino.jumping = true;
    }
});

//obstacle
let obstacle = {
    x: 800,
    y: 220,
    width: 20,
    height: 30,
    speed: 6
};

// reset game
function resetGame() {
    dino.y = 200;
    dino.velocityY = 0;
    dino.jumping = false;

    obstacle.x = canvas.width;
    obstacle.speed = 6;

    gameOver = false;
    update();
};

//game loop
function update() {
    if (gameOver) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    //dino physics
    dino.velocityY += gravity;
    dino.y += dino.velocityY;

    if (dino.y >= 200) {
        dino.y = 200;
        dino.velocityY = 0;
        dino.jumping = false;
    };

    //move obstacle
    obstacle.x -= obstacle.speed;
    if (obstacle.x < -obstacle.width) {
        obstacle.x = 800;
    };

    //draw dino
    ctx.fillStyle = "green";
    ctx.fillRect(dino.x, dino.y, dino.width, dino.height);

    //draw obstacle
    ctx.fillStyle = "red";
    ctx.fillRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);

    //collision detection
    if (
        dino.x < obstacle.x + obstacle.width &&
        dino.x + dino.width > obstacle.x &&
        dino.y < obstacle.y + obstacle.height &&
        dino.y + dino.height > obstacle.y
    ) {
       gameOver = true;

       alert("Game Over!")
       setTimeout(() => {
        resetGame();
       }, 1000);
    };

    requestAnimationFrame(update);
};

update();