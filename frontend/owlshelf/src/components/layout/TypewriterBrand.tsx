import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';

interface TypewriterBrandProps {
    text: string;
}

export const TypewriterBrand: React.FC<TypewriterBrandProps> = ({ text }) => {
    const letters = Array.from(text);
    const [isMobile, setIsMobile] = useState(false);

    // ตรวจสอบขนาดหน้าจอเพื่อปรับขนาด font และ เคอร์เซอร์ อัตโนมัติ
    useEffect(() => {
        const checkMobile = () => {
            setIsMobile(window.innerWidth <= 768); // หน้าจอเล็กกว่า 768px คือมือถือ
        };
        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    // คำนวณขนาดตามอุปกรณ์
    const fontSize = isMobile ? '2.8rem' : '4.5rem';
    const cursorHeight = isMobile ? '2.5rem' : '4.2rem';

    return (
        /* เพิ่ม whileTap สั่งให้เรืองแสงเป็นสีทองตอนนิ้วจิ้มในมือถือด้วย */
        <motion.div
            whileHover="hover"
            whileTap="hover"
            style={{ display: 'inline-flex', alignItems: 'center', fontFamily: 'monospace', cursor: 'default' }}
        >
            <h1 style={{
                display: 'inline-flex',
                flexWrap: 'nowrap', // บังคับไม่ให้ตัวอักษรร่วงตกบรรทัดเด็ดขาด
                margin: 0,
                fontSize: fontSize,
                fontWeight: 'bold',
                letterSpacing: isMobile ? '1px' : '2px', // ลดระยะห่างตัวอักษรลงนิดนึงในมือถือ
                color: '#4A3728'
            }}>
                {letters.map((letter, index) => (
                    <motion.span
                        key={index}
                        initial={{ opacity: 0, y: 10, width: 0 }}
                        animate={{ opacity: 1, y: 0, width: 'auto' }}
                        transition={{
                            type: "tween",
                            ease: "easeOut",
                            duration: 0.15,
                            delay: index * 0.1
                        }}
                        variants={{
                            hover: {
                                color: '#D4AF37',
                                textShadow: "0px 0px 14px rgba(212, 175, 55, 0.7), 0px 0px 4px rgba(212, 175, 55, 0.4)",
                                transition: { duration: 0.25 }
                            }
                        }}
                        style={{ display: 'inline-block', overflow: 'hidden', whiteSpace: 'nowrap' }}
                    >
                        {letter === " " ? "\u00A0" : letter}
                    </motion.span>
                ))}
            </h1>

            {/* เคอร์เซอร์กะพริบที่จะย่อขนาดตามความสูงตัวอักษรในมือถือด้วย */}
            <motion.span
                style={{
                    display: 'inline-block',
                    width: isMobile ? '3px' : '4px', // ลดความหนาเคอร์เซอร์บนมือถือ
                    height: cursorHeight,
                    backgroundColor: '#4E7A5C',
                    marginLeft: '6px',
                }}
                variants={{
                    hover: {
                        backgroundColor: '#E6D3A0',
                        boxShadow: "0px 0px 14px rgba(230, 211, 160, 0.8), 0px 0px 4px rgba(230, 211, 160, 0.4)",
                        transition: { duration: 0.25 }
                    }
                }}
                animate={{ opacity: [1, 0] }}
                transition={{
                    repeat: Infinity,
                    duration: 0.8,
                    ease: "linear",
                    repeatType: "reverse"
                }}
            />
        </motion.div>
    );
};
